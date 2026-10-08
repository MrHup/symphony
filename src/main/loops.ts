// Loops: a chain of steps run on one project, repeated until the last step moves forward.
//
// Each agent step runs as its own session. When it finishes, it decides where the loop goes by
// calling the loop_route tool (forward to the next step, or back to an earlier one) and hands over
// a summary plus artifacts. Human steps wait for the user, who decides in the loop panel. Unless the
// loop turns it off, prompts are improved with /optimize-prompt when the loop starts, and reused until a step changes.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { GhIdentity, LoopArtifact, LoopDecision, LoopDraft, LoopHandoff, LoopInfo, LoopStep, MainEvent, Project } from '@shared/types'
import { extractOptimizedPrompt, OPTIMIZE_LINGER_MS, optimizeCommand } from './pipeline'
import { assetIdsOfLoop, type AssetStore } from './assets'
import type { SessionManager } from './sessions'

const ROUTE_SERVER = 'symphony_loop'
const ROUTE_TOOL = `mcp__${ROUTE_SERVER}__loop_route`
export const DEFAULT_MAX_RUNS = 12
/** How many earlier moves a step is shown, newest last. */
const HISTORY_IN_PROMPT = 6

const NUDGE =
  'You ended your turn without calling the loop_route tool, so the loop cannot continue. Call loop_route now: forward to hand your work to the next step, or back with the step number that has to redo work.'

interface Deps {
  sessions: SessionManager
  emit(e: MainEvent): void
  persist(): void
  project(id: string): Project
  identityFor(cwd: string): Promise<{ identity: GhIdentity; env: Record<string, string> }>
  defaultModel(): string
  assets: AssetStore
  /** Files that may no longer be needed (deleted unless something else refers to them). */
  releaseFiles(ids: string[]): void
}

interface Route {
  decision: 'forward' | 'back'
  toStep: number | null
  summary: string
  artifacts: LoopArtifact[]
}

const stepLabel = (l: LoopInfo, i: number) => `step ${i + 1} ("${l.steps[i].title}")`
const optimizeKey = (s: LoopStep) => `${s.prompt}\u0000${s.images?.length ?? 0}`

export class LoopManager {
  private loops = new Map<string, LoopInfo>()
  /** Routing decisions made with loop_route, by session id, applied when that session's turn ends. */
  private routes = new Map<string, Route>()
  /** Sessions already reminded once to route. */
  private nudged = new Set<string>()

  constructor(private d: Deps) {}

  /** Loops come back from disk; any step that was mid-run when Symphony closed is paused for the user. */
  restore(list: LoopInfo[]): void {
    for (const l of list) {
      if (l.state === 'running') {
        l.state = 'paused'
        l.pausedReason = 'Symphony was closed while this step was running. Rerun it, or route the loop yourself.'
      } else if (l.state === 'optimizing') {
        l.state = 'stopped'
        l.current = null
      }
      this.loops.set(l.id, l)
    }
  }

  list(): LoopInfo[] {
    return [...this.loops.values()]
  }

  create(projectId: string, draft: LoopDraft): LoopInfo {
    this.d.project(projectId)
    const l: LoopInfo = {
      id: randomUUID(),
      projectId,
      ...clean(draft),
      state: 'draft',
      current: null,
      runs: 0,
      history: [],
      createdAt: Date.now()
    }
    this.loops.set(l.id, l)
    this.changed(l)
    return l
  }

  update(id: string, draft: LoopDraft): LoopInfo {
    const l = this.need(id)
    if (!['draft', 'stopped', 'done'].includes(l.state)) throw new Error('Stop the loop before editing it.')
    const prev = new Map(l.steps.map((s) => [s.id, s]))
    Object.assign(l, clean(draft))
    // Keep cached optimizations for steps whose prompt did not change.
    for (const s of l.steps) {
      const old = prev.get(s.id)
      if (old?.optimized && old.optimizedFrom === optimizeKey(s)) {
        s.optimized = old.optimized
        s.optimizedFrom = old.optimizedFrom
      }
    }
    this.changed(l)
    return l
  }

  delete(id: string): void {
    const l = this.loops.get(id)
    if (!l) return
    l.state = 'stopped'
    for (const s of this.d.sessions.list()) if (s.loopId === id) this.d.sessions.dismiss(s.id)
    this.loops.delete(id)
    this.d.emit({ type: 'loopRemoved', id })
    this.d.persist()
    this.d.releaseFiles(assetIdsOfLoop(l))
  }

  /** Start from step 1 (draft, stopped or done), or rerun the current step of a paused loop. */
  async start(id: string): Promise<void> {
    const l = this.need(id)
    if (l.state === 'paused' && l.current !== null) {
      l.runsAtHuman = l.runs
      return this.runStep(l, l.current, l.history.at(-1))
    }
    if (!['draft', 'stopped', 'done'].includes(l.state)) return
    if (!l.steps.length) throw new Error('The loop has no steps.')
    // A new run starts a new history; the files the old one handed over can go.
    const handedOver = assetIdsOfLoop(l)
    l.runs = 0
    l.runsAtHuman = 0
    l.history = []
    this.d.releaseFiles(handedOver)
    l.current = null
    l.pausedReason = undefined
    for (const s of this.d.sessions.list()) if (s.loopId === id) this.d.sessions.archive(s.id)
    if (l.optimize === false) return this.runStep(l, 0)
    await this.optimize(l)
    if (l.state === 'optimizing') await this.runStep(l, 0)
  }

  stop(id: string): void {
    const l = this.need(id)
    if (['draft', 'stopped', 'done'].includes(l.state)) return
    const from = l.current ?? 0
    const active = l.activeSessionId
    l.state = 'stopped'
    l.history.push({ fromStep: from, decision: 'stop', toStep: null, by: 'human', summary: 'Stopped by the user.', artifacts: [], at: Date.now() })
    l.current = null
    this.changed(l)
    if (active) void this.d.sessions.stop(active)
  }

  /** The user's decision on a human step, or on a paused loop. */
  async decide(id: string, choice: LoopDecision): Promise<void> {
    const l = this.need(id)
    if ((l.state !== 'waiting' && l.state !== 'paused') || l.current === null) return
    if (choice.decision === 'stop') return this.stop(id)
    const from = l.current
    const last = l.history.at(-1)
    let toStep: number | null
    if (choice.decision === 'back') {
      const target = choice.step ?? from
      if (target < 0 || target > from) throw new Error('Pick this step or an earlier one.')
      toStep = target
    } else {
      toStep = from + 1 < l.steps.length ? from + 1 : null
    }
    const feedback = choice.feedback.trim()
    l.runsAtHuman = l.runs
    await this.advance(l, {
      fromStep: from,
      decision: choice.decision,
      toStep,
      by: 'human',
      summary: feedback || (choice.decision === 'forward' ? 'Approved by the user.' : 'Sent back by the user without further notes.'),
      // What the previous step handed over stays available to the next one.
      artifacts: last?.artifacts ?? [],
      at: Date.now()
    })
  }

  // ---------- running ----------

  /** Improve each agent step's prompt with /optimize-prompt, in parallel, reusing earlier results. */
  private async optimize(l: LoopInfo): Promise<void> {
    l.state = 'optimizing'
    this.changed(l)
    const project = this.d.project(l.projectId)
    const { identity, env } = await this.d.identityFor(project.path)
    const todo = l.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'agent' && s.optimizedFrom !== optimizeKey(s))
    await Promise.all(
      todo.map(
        ({ s, i }) =>
          new Promise<void>((resolve) => {
            const context = `This prompt is ${stepLabel(l, i)} of ${l.steps.length} in a loop of separate Claude Code sessions. When it runs, the session also receives what the previous step handed over (a summary and files or links to look at) and instructions for passing the work on, so do not add hand-off instructions of your own.`
            const session = this.d.sessions.start({
              kind: 'optimize',
              anchorId: l.id,
              projectId: l.projectId,
              cwd: project.path,
              prompt: optimizeCommand(s.prompt, s.images?.length ?? 0, context),
              model: s.model ?? this.d.defaultModel(),
              effort: s.effort,
              title: s.title,
              identity,
              env,
              loopId: l.id,
              loopStep: i,
              onResult: (reply, isError) => {
                const optimized = isError ? null : extractOptimizedPrompt(reply)
                if (optimized) {
                  s.optimized = optimized
                  s.optimizedFrom = optimizeKey(s)
                  this.d.sessions.markHandedOff(session.id)
                  setTimeout(() => this.d.sessions.dismiss(session.id), OPTIMIZE_LINGER_MS)
                }
                // Without a usable rewrite the step runs with its original prompt; the session stays visible.
                resolve()
              }
            })
          })
      )
    )
    this.changed(l)
  }

  private async runStep(l: LoopInfo, index: number, handoff?: LoopHandoff): Promise<void> {
    const step = l.steps[index]
    if (l.activeSessionId) this.d.sessions.archive(l.activeSessionId)
    l.current = index
    l.activeSessionId = undefined
    l.pausedReason = undefined
    if (step.kind === 'human') {
      l.state = 'waiting'
      this.changed(l)
      return
    }
    if (l.runs - (l.runsAtHuman ?? 0) >= l.maxRuns) {
      return this.pause(l, `The loop ran ${l.maxRuns} agent steps in a row without a human decision. Route it yourself to continue, or stop it.`)
    }
    l.runs += 1
    l.state = 'running'
    this.changed(l)

    const project = this.d.project(l.projectId)
    const { identity, env } = await this.d.identityFor(project.path)
    let sessionId = ''
    const session = this.d.sessions.start({
      kind: 'loop',
      anchorId: l.id,
      projectId: l.projectId,
      cwd: project.path,
      prompt: buildStepPrompt(l, index, handoff),
      images: step.images,
      model: step.model ?? this.d.defaultModel(),
      effort: step.effort,
      title: step.title,
      identity,
      env,
      loopId: l.id,
      loopStep: index,
      tools: { mcpServers: { [ROUTE_SERVER]: this.routeServer(l, index, () => sessionId) }, allowedTools: [ROUTE_TOOL] },
      onResult: (_text, isError) => void this.onStepTurnEnd(l.id, sessionId, isError)
    })
    sessionId = session.id
    l.activeSessionId = session.id
    this.changed(l)
  }

  /** The loop_route tool, bound to one step run. */
  private routeServer(l: LoopInfo, index: number, sessionId: () => string): McpSdkServerConfigWithInstance {
    const n = l.steps.length
    const next = index + 1 < n ? stepLabel(l, index + 1) : null
    return createSdkMcpServer({
      name: ROUTE_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      tools: [
        tool(
          'loop_route',
          `Decide where the loop goes after your step, and hand over your work. Call it exactly once, as your last action. forward: ${next ? `hand your work to ${next}` : 'you are the last step, so this completes the loop'}. back: send the work back to an earlier step (1-${index + 1}; ${index + 1} reruns your own step) because it has to be redone. Image, PDF and other viewable file artifacts are copied now and shown to a human reviewer, who may be on another computer.`,
          {
            next: z.enum(['forward', 'back']).describe('forward: the work is good enough to move on. back: an earlier step must redo work.'),
            step: z.number().int().optional().describe(`With back: the step number to return to, 1-${index + 1}.`),
            summary: z
              .string()
              .describe('What you did or found. With back: exactly what must change. The receiving step only sees this and the artifacts.'),
            artifacts: z
              .array(
                z.object({
                  label: z.string().describe('What this is, e.g. "Generated report".'),
                  path: z.string().optional().describe('A file, a folder, or a pattern such as out/*.png; absolute or relative to the project folder.'),
                  url: z.string().optional().describe('A link, e.g. a local server page.')
                })
              )
              .optional()
              .describe('Files or links the next step (or a human reviewer) should open.')
          },
          async (args) => {
            if (args.next === 'back' && (!args.step || args.step < 1 || args.step > index + 1)) {
              return { isError: true, content: [{ type: 'text', text: `With next "back", step must be a number from 1 to ${index + 1}.` }] }
            }
            const toStep = args.next === 'back' ? args.step! - 1 : index + 1 < n ? index + 1 : null
            const { artifacts, skipped } = await this.copyArtifacts(l.projectId, (args.artifacts ?? []).filter((a) => a.path || a.url))
            this.routes.set(sessionId(), { decision: args.next, toStep, summary: args.summary, artifacts })
            const where = toStep === null ? 'the loop completes' : `the loop continues with ${stepLabel(l, toStep)}`
            const note = skipped.length ? ` These artifacts could not be copied and are passed on as paths only: ${skipped.join('; ')}.` : ''
            return { content: [{ type: 'text', text: `Recorded: ${where}.${note} End your turn now without further tool calls.` }] }
          }
        )
      ]
    })
  }

  /**
   * Copy the files a step hands over, so the reviewer sees exactly what the step produced. Folders
   * and patterns become one artifact per file; links and files that cannot be shown stay as paths.
   */
  private async copyArtifacts(projectId: string, list: LoopArtifact[]): Promise<{ artifacts: LoopArtifact[]; skipped: string[] }> {
    const base = this.d.project(projectId).path
    const artifacts: LoopArtifact[] = []
    const skipped: string[] = []
    for (const a of list) {
      if (!a.path) {
        artifacts.push(a)
        continue
      }
      const got = await this.d.assets.collect(base, [a.path]).catch((err: Error) => ({ files: [], skipped: [err.message] }))
      skipped.push(...got.skipped)
      if (!got.files.length) artifacts.push(a)
      else if (got.files.length === 1) artifacts.push({ ...a, path: got.files[0].path, asset: got.files[0] })
      else artifacts.push(...got.files.map((f) => ({ label: `${a.label}: ${f.name}`, path: f.path, asset: f })))
    }
    return { artifacts, skipped }
  }

  private async onStepTurnEnd(loopId: string, sessionId: string, isError: boolean): Promise<void> {
    const l = this.loops.get(loopId)
    if (!l || l.state !== 'running' || l.activeSessionId !== sessionId || l.current === null) return
    const route = this.routes.get(sessionId)
    if (route) {
      this.routes.delete(sessionId)
      this.nudged.delete(sessionId)
      return this.advance(l, { fromStep: l.current, ...route, by: 'agent', sessionId, at: Date.now() })
    }
    if (isError) return this.pause(l, `${capitalize(stepLabel(l, l.current))} stopped before it chose where the loop goes next.`)
    if (!this.nudged.has(sessionId)) {
      this.nudged.add(sessionId)
      this.d.sessions.send(sessionId, NUDGE)
      return
    }
    this.pause(l, `${capitalize(stepLabel(l, l.current))} ended without choosing where the loop goes next.`)
  }

  private async advance(l: LoopInfo, h: LoopHandoff): Promise<void> {
    l.history.push(h)
    if (h.toStep === null) {
      if (l.activeSessionId) this.d.sessions.archive(l.activeSessionId)
      l.state = 'done'
      l.current = null
      l.activeSessionId = undefined
      this.changed(l)
      return
    }
    await this.runStep(l, h.toStep, h)
  }

  private pause(l: LoopInfo, reason: string): void {
    l.state = 'paused'
    l.pausedReason = reason
    this.changed(l)
  }

  private need(id: string): LoopInfo {
    const l = this.loops.get(id)
    if (!l) throw new Error('Unknown loop')
    return l
  }

  private changed(l: LoopInfo): void {
    this.d.emit({ type: 'loop', loop: structuredClone(l) })
    this.d.persist()
  }
}

function clean(draft: LoopDraft): Pick<LoopInfo, 'name' | 'steps' | 'maxRuns' | 'optimize'> {
  const steps = draft.steps
    .filter((s) => s.prompt.trim() || s.kind === 'human')
    .map((s, i) => ({
      ...s,
      id: s.id || randomUUID(),
      title: s.title.trim() || `${s.kind === 'human' ? 'Review' : 'Step'} ${i + 1}`,
      prompt: s.prompt.trim(),
      ...(s.kind === 'human' ? { model: undefined, effort: undefined, images: undefined, optimized: undefined, optimizedFrom: undefined } : {})
    }))
  return {
    name: draft.name.trim() || 'Loop',
    steps,
    maxRuns: Math.max(1, Math.min(100, Math.round(draft.maxRuns || DEFAULT_MAX_RUNS))),
    optimize: draft.optimize !== false
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function artifactLines(artifacts: LoopArtifact[]): string {
  return artifacts.map((a) => `- ${a.label}: ${a.path ?? a.url}`).join('\n')
}

/** The first message of a step run: where it sits in the loop, what it was handed, its task, and how to route. */
export function buildStepPrompt(l: LoopInfo, index: number, handoff?: LoopHandoff): string {
  const step = l.steps[index]
  const n = l.steps.length
  const outline = l.steps.map((s, i) => `${i + 1}. ${s.title} (${s.kind === 'human' ? 'human review' : 'agent'})${i === index ? '  <- you' : ''}`).join('\n')
  const parts: string[] = [
    `You are ${stepLabel(l, index)} of ${n} in the loop "${l.name}", which Symphony runs on this project. Each step is a separate session, so you only know what earlier steps handed over below. The loop repeats until its last step moves forward.`,
    `<loop_steps>\n${outline}\n</loop_steps>`
  ]
  const earlier = l.history.slice(-HISTORY_IN_PROMPT - 1, -1).filter((h) => h.decision !== 'stop')
  if (earlier.length) {
    const lines = earlier.map((h) => `- ${capitalize(stepLabel(l, h.fromStep))} ${h.decision === 'back' ? `sent the work back to step ${(h.toStep ?? 0) + 1}` : 'moved forward'}: ${h.summary.split('\n')[0].slice(0, 200)}`)
    parts.push(`<earlier_moves>\n${lines.join('\n')}\n</earlier_moves>`)
  }
  if (handoff) {
    const who = handoff.by === 'human' ? `the user, at ${stepLabel(l, handoff.fromStep)}` : stepLabel(l, handoff.fromStep)
    const why = handoff.decision === 'back' ? `${capitalize(who)} sent the work back to you. Address this first:` : `${capitalize(who)} handed over:`
    const files = handoff.artifacts.length ? `\n\nArtifacts:\n${artifactLines(handoff.artifacts)}` : ''
    parts.push(`<handoff>\n${why}\n\n${handoff.summary}${files}\n</handoff>`)
  }
  parts.push(`<task>\n${l.optimize === false ? step.prompt : (step.optimized ?? step.prompt)}\n</task>`)
  const nextStep = index + 1 < n ? l.steps[index + 1] : null
  const forward = nextStep
    ? `next "forward" hands your work to ${stepLabel(l, index + 1)}${nextStep.kind === 'human' ? ', a human review: list in artifacts every file or link the reviewer should open, and say in summary what to check' : ''}.`
    : 'next "forward" completes the loop; use it only when the work meets the goal.'
  parts.push(
    [
      'When your work for this step is done, call the loop_route tool once, as your last action:',
      `- ${forward}`,
      `- next "back" with step 1-${index + 1} sends the work to an earlier step (or reruns yours) when it has to be redone; say in summary exactly what must change.`,
      'Put everything the receiving step needs in summary and artifacts; it cannot see this session.'
    ].join('\n')
  )
  return parts.join('\n\n')
}
