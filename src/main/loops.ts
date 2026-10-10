// Loops: a graph of steps that belongs to one device and runs there, until it reaches a step with
// nowhere to go.
//
// Each agent step runs as its own session in its session folder, reads its input folder and writes
// its output folder; folders are the only way steps share work. Edges between steps can carry a
// prompt, which goes in front of the next step's prompt when the loop moves along them. An agent
// step with several ways out picks one with the loop_route tool. Human steps wait for the user, who
// approves or sends the loop back to an earlier step with a prompt. Unless the loop turns it off,
// prompts are improved with /optimize-prompt when the loop starts, and reused until a step changes.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { GhIdentity, LoopDecision, LoopDraft, LoopEdge, LoopFile, LoopFolder, LoopFolderRole, LoopInfo, LoopMove, LoopStep, MainEvent, Project } from '@shared/types'
import { extractOptimizedPrompt, OPTIMIZE_LINGER_MS, optimizeCommand } from './pipeline'
import type { SessionManager } from './sessions'
import { dataPath } from './store'

const ROUTE_SERVER = 'symphony_loop'
const ROUTE_TOOL = `mcp__${ROUTE_SERVER}__loop_route`
export const DEFAULT_MAX_RUNS = 12
/** Most files a folder listing shows. */
const MAX_LISTED = 200

const NUDGE = 'You ended your turn without calling the loop_route tool, so the loop cannot continue. Call loop_route now with the number of the step the loop goes to next.'

interface Deps {
  sessions: SessionManager
  emit(e: MainEvent): void
  persist(): void
  identityFor(cwd: string): Promise<{ identity: GhIdentity; env: Record<string, string> }>
  defaultModel(): string
}

interface StepFolders {
  session: string
  input: string
  output: string
}

const optimizeKey = (s: LoopStep) => `${s.prompt}\u0000${s.images?.length ?? 0}`
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** Where a loop's temporary folders live. */
const loopDir = (id: string) => dataPath(join('loops', id))
const linked = (l: LoopInfo, stepId: string, role: LoopFolderRole) => l.links.find((k) => k.stepId === stepId && k.role === role)?.folderId
const outgoing = (l: LoopInfo, stepId: string) => l.edges.filter((e) => e.from === stepId)

export class LoopManager {
  private loops = new Map<string, LoopInfo>()
  /** Edges chosen with loop_route, by session id, followed when that session's turn ends. */
  private routes = new Map<string, LoopEdge>()
  /** Sessions already reminded once to route. */
  private nudged = new Set<string>()

  constructor(private d: Deps) {}

  /** Loops come back from disk; any step that was mid-run when Symphony closed is paused for the user. */
  restore(list: LoopInfo[], projects: Project[]): void {
    for (const saved of list) {
      const l = 'projectId' in saved ? fromLinear(saved as unknown as LinearLoop, projects) : saved
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

  create(draft: LoopDraft): LoopInfo {
    const l: LoopInfo = {
      id: randomUUID(),
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

  /** Deletes the loop, its sessions and its temporary folders. */
  delete(id: string): void {
    const l = this.loops.get(id)
    if (!l) return
    l.state = 'stopped'
    for (const s of this.d.sessions.list()) if (s.loopId === id) this.d.sessions.dismiss(s.id)
    this.loops.delete(id)
    rmSync(loopDir(id), { recursive: true, force: true })
    this.d.emit({ type: 'loopRemoved', id })
    this.d.persist()
  }

  /** Start at the start step (draft, stopped or done), or rerun the current step of a paused loop. */
  async start(id: string): Promise<void> {
    const l = this.need(id)
    if (l.state === 'paused' && l.current) {
      l.runsAtHuman = l.runs
      const last = l.history.at(-1)
      return this.runStep(l, l.current, last?.to === l.current ? last.prompt : undefined)
    }
    if (!['draft', 'stopped', 'done'].includes(l.state)) return
    check(l)
    ensureFolders(l)
    l.runs = 0
    l.runsAtHuman = 0
    l.history = []
    l.current = null
    l.pausedReason = undefined
    for (const s of this.d.sessions.list()) if (s.loopId === id) this.d.sessions.archive(s.id)
    if (l.optimize === false) return this.runStep(l, l.start!)
    await this.optimize(l)
    if (l.state === 'optimizing') await this.runStep(l, l.start!)
  }

  stop(id: string): void {
    const l = this.need(id)
    if (['draft', 'stopped', 'done'].includes(l.state)) return
    const active = l.activeSessionId
    l.state = 'stopped'
    l.history.push({ from: l.current ?? l.start ?? '', decision: 'stop', to: null, by: 'human', at: Date.now() })
    l.current = null
    this.changed(l)
    if (active) void this.d.sessions.stop(active)
  }

  /** The user's decision on a human step, or on a paused loop. */
  async decide(id: string, choice: LoopDecision): Promise<void> {
    const l = this.need(id)
    if ((l.state !== 'waiting' && l.state !== 'paused') || !l.current) return
    if (choice.decision === 'stop') return this.stop(id)
    const from = l.current
    l.runsAtHuman = l.runs
    if (choice.decision === 'back') {
      if (!choice.step || !earlierSteps(l).some((s) => s.id === choice.step)) throw new Error('Pick a step the loop has already been through.')
      return this.advance(l, { from, decision: 'back', to: choice.step, by: 'human', prompt: choice.prompt?.trim() || undefined, at: Date.now() })
    }
    const out = outgoing(l, from)
    const edge = out.length === 1 ? out[0] : out.find((e) => e.id === choice.edge)
    if (out.length > 1 && !edge) throw new Error('Pick where the loop goes next.')
    await this.advance(l, { from, decision: 'forward', to: edge?.to ?? null, by: 'human', prompt: edge?.prompt, at: Date.now() })
  }

  /** Files in one of the loop's folders, newest first. */
  async files(id: string, folderId: string): Promise<LoopFile[]> {
    const root = folderPath(this.need(id), folderId)
    const files: LoopFile[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (files.length >= MAX_LISTED || d.name.startsWith('.')) continue
        const full = join(dir, d.name)
        if (d.isDirectory()) await walk(full)
        else if (d.isFile()) {
          const info = await stat(full)
          files.push({ path: relative(root, full).split(sep).join('/'), size: info.size, modified: info.mtimeMs })
        }
      }
    }
    await walk(root)
    return files.sort((a, b) => b.modified - a.modified)
  }

  /** A file in one of the loop's folders; paths that leave the folder are refused. */
  filePath(id: string, folderId: string, path: string): string {
    const root = folderPath(this.need(id), folderId)
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('That file is not in the folder.')
    return full
  }

  // ---------- running ----------

  /** Improve each agent step's prompt with /optimize-prompt, in parallel, reusing earlier results. */
  private async optimize(l: LoopInfo): Promise<void> {
    l.state = 'optimizing'
    this.changed(l)
    const todo = l.steps.filter((s) => s.kind === 'agent' && s.optimizedFrom !== optimizeKey(s))
    await Promise.all(
      todo.map(async (s) => {
        const cwd = stepFolders(l, s.id).session
        const { identity, env } = await this.d.identityFor(cwd)
        const context = `This prompt is the step "${s.title}" in a loop of separate Claude Code sessions. When it runs, the session also receives the paths of its input and output folders, any prompt from the step before, and instructions for passing the work on, so do not add hand-off instructions of your own.`
        await new Promise<void>((resolve) => {
          const session = this.d.sessions.start({
            kind: 'optimize',
            anchorId: l.id,
            projectId: null,
            cwd,
            prompt: optimizeCommand(s.prompt, s.images?.length ?? 0, context),
            model: s.model ?? this.d.defaultModel(),
            effort: s.effort,
            title: s.title,
            identity,
            env,
            loopId: l.id,
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
      })
    )
    this.changed(l)
  }

  /** `prompt` goes in front of the step's own: the edge's prompt, or the one you sent the loop back with. */
  private async runStep(l: LoopInfo, stepId: string, prompt?: string): Promise<void> {
    const step = l.steps.find((s) => s.id === stepId)!
    if (l.activeSessionId) this.d.sessions.archive(l.activeSessionId)
    l.current = stepId
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
    let dirs: StepFolders
    try {
      ensureFolders(l)
      dirs = stepFolders(l, stepId)
    } catch (err) {
      return this.pause(l, (err as Error).message)
    }
    l.runs += 1
    l.state = 'running'
    this.changed(l)

    const out = outgoing(l, stepId)
    const { identity, env } = await this.d.identityFor(dirs.session)
    let sessionId = ''
    const session = this.d.sessions.start({
      kind: 'loop',
      anchorId: l.id,
      projectId: null,
      cwd: dirs.session,
      additionalDirectories: [dirs.input, dirs.output],
      prompt: buildStepPrompt(l, step, dirs, prompt),
      images: step.images,
      model: step.model ?? this.d.defaultModel(),
      effort: step.effort,
      title: step.title,
      identity,
      env,
      loopId: l.id,
      tools: out.length > 1 ? { mcpServers: { [ROUTE_SERVER]: this.routeServer(l, out, () => sessionId) }, allowedTools: [ROUTE_TOOL] } : undefined,
      onResult: (_text, isError) => void this.onStepTurnEnd(l.id, sessionId, isError)
    })
    sessionId = session.id
    l.activeSessionId = session.id
    this.changed(l)
  }

  /** The loop_route tool, bound to one step run with several ways out. */
  private routeServer(l: LoopInfo, out: LoopEdge[], sessionId: () => string): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: ROUTE_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      tools: [
        tool(
          'loop_route',
          `Choose the step the loop goes to after yours. Call it exactly once, as your last action. ${routeChoices(l, out)}`,
          { step: z.number().int().describe(`The number of the next step, 1-${out.length}.`) },
          async (args) => {
            const edge = out[args.step - 1]
            if (!edge) return { isError: true, content: [{ type: 'text', text: `step must be a number from 1 to ${out.length}.` }] }
            this.routes.set(sessionId(), edge)
            return { content: [{ type: 'text', text: `Recorded: the loop continues with ${stepName(l, edge.to)}. End your turn now without further tool calls.` }] }
          }
        )
      ]
    })
  }

  private async onStepTurnEnd(loopId: string, sessionId: string, isError: boolean): Promise<void> {
    const l = this.loops.get(loopId)
    if (!l || l.state !== 'running' || l.activeSessionId !== sessionId || !l.current) return
    const out = outgoing(l, l.current)
    const route = this.routes.get(sessionId)
    // With one way out (or none) there is nothing to choose: the loop moves on when the turn ends.
    if (route || (out.length <= 1 && !isError)) {
      this.routes.delete(sessionId)
      this.nudged.delete(sessionId)
      const edge = route ?? out[0]
      return this.advance(l, { from: l.current, decision: 'forward', to: edge?.to ?? null, by: 'agent', prompt: edge?.prompt, sessionId, at: Date.now() })
    }
    const name = capitalize(stepName(l, l.current))
    if (isError) return this.pause(l, `${name} stopped before it finished.`)
    if (!this.nudged.has(sessionId)) {
      this.nudged.add(sessionId)
      this.d.sessions.send(sessionId, NUDGE)
      return
    }
    this.pause(l, `${name} ended without choosing where the loop goes next.`)
  }

  private async advance(l: LoopInfo, move: LoopMove): Promise<void> {
    l.history.push(move)
    if (move.to === null) {
      if (l.activeSessionId) this.d.sessions.archive(l.activeSessionId)
      l.state = 'done'
      l.current = null
      l.activeSessionId = undefined
      this.changed(l)
      return
    }
    await this.runStep(l, move.to, move.prompt)
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

// ---------- the graph ----------

const stepName = (l: LoopInfo, id: string) => `the step "${l.steps.find((s) => s.id === id)?.title ?? '?'}"`

/** Agent steps the loop has already run in this run: where you can send it back to. */
export function earlierSteps(l: LoopInfo): LoopStep[] {
  return l.steps.filter((s) => s.kind === 'agent' && l.history.some((h) => h.from === s.id && h.decision !== 'stop'))
}

/** A folder's path on this device. */
export function folderPath(l: LoopInfo, id: string): string {
  const f = l.folders.find((x) => x.id === id)
  if (!f) throw new Error('Unknown folder')
  if (f.parentId) return join(folderPath(l, f.parentId), f.name)
  return f.path ?? join(loopDir(l.id), f.name)
}

function stepFolders(l: LoopInfo, stepId: string): StepFolders {
  const path = (role: LoopFolderRole) => folderPath(l, linked(l, stepId, role) ?? '')
  return { session: path('session'), input: path('input'), output: path('output') }
}

/** Create the temporary and nested folders; permanent ones must already exist. */
function ensureFolders(l: LoopInfo): void {
  for (const f of l.folders) {
    if (f.parentId || f.path === undefined) continue
    if (!existsSync(f.path) || !statSync(f.path).isDirectory()) throw new Error(`The folder ${f.path} ("${f.name}") does not exist.`)
  }
  for (const f of l.folders) if (f.parentId || f.path === undefined) mkdirSync(folderPath(l, f.id), { recursive: true })
}

/** What a loop needs before it can run, as one readable error. */
function check(l: LoopInfo): void {
  if (!l.start) throw new Error('The loop has no steps.')
  for (const f of l.folders) if (f.path === '' && !f.parentId) throw new Error(`Pick the folder "${f.name}" stands for.`)
  for (const s of l.steps) {
    const name = `"${s.title}"`
    if (s.kind === 'human') {
      if (!linked(l, s.id, 'input')) throw new Error(`Connect an input folder to ${name}, for you to review.`)
      continue
    }
    if (!s.prompt) throw new Error(`${name} has no prompt.`)
    const missing = (['session', 'input', 'output'] as const).filter((r) => !linked(l, s.id, r))
    if (missing.length) throw new Error(`Connect ${name} to its ${missing.join(' and ')} folder${missing.length > 1 ? 's' : ''}.`)
    if (linked(l, s.id, 'input') === linked(l, s.id, 'session')) throw new Error(`${name} needs an input folder apart from its session folder.`)
  }
}

/** The editor's draft, made consistent: links and edges only between things that exist, one folder per role. */
function clean(draft: LoopDraft): Omit<LoopDraft, 'optimize'> & { optimize: boolean } {
  const steps = draft.steps.map((s, i) => ({
    ...s,
    title: s.title.trim() || `${s.kind === 'human' ? 'Review' : 'Step'} ${i + 1}`,
    prompt: s.prompt.trim(),
    ...(s.kind === 'human' ? { model: undefined, effort: undefined, images: undefined, optimized: undefined, optimizedFrom: undefined } : {})
  }))
  const kinds = new Map(steps.map((s) => [s.id, s.kind]))
  const ids = new Set(draft.folders.map((f) => f.id))
  const folders = draft.folders.map((f) => {
    const name = f.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()
    if (!name || name === '.' || name === '..') throw new Error('Give every folder a name.')
    if (f.parentId && !ids.has(f.parentId)) throw new Error(`The folder "${name}" is inside a folder that no longer exists.`)
    const path = f.parentId || f.path === undefined ? undefined : f.path.trim()
    if (path && !isAbsolute(path)) throw new Error(`The folder "${name}" needs a full path.`)
    return { ...f, name, path }
  })
  // A nested folder may not end up inside itself, and two folders in one place need different names.
  const byId = new Map(folders.map((f) => [f.id, f]))
  const places = new Set<string>()
  for (const f of folders) {
    for (let p = f.parentId, n = 0; p; p = byId.get(p)?.parentId, n++) if (p === f.id || n > folders.length) throw new Error(`The folder "${f.name}" is inside itself.`)
    if (f.path !== undefined) continue
    const place = `${f.parentId ?? ''}/${f.name.toLowerCase()}`
    if (places.has(place)) throw new Error(`Two folders in the same place are both called "${f.name}".`)
    places.add(place)
  }
  const links = new Map<string, LoopDraft['links'][number]>()
  for (const k of draft.links) {
    const kind = kinds.get(k.stepId)
    if (kind && byId.has(k.folderId) && (kind === 'agent' || k.role === 'input')) links.set(`${k.stepId}:${k.role}`, k)
  }
  const edges = new Map<string, LoopEdge>()
  for (const e of draft.edges) {
    if (e.from === e.to || !kinds.has(e.from) || !kinds.has(e.to)) continue
    edges.set(`${e.from}>${e.to}`, { id: e.id, from: e.from, to: e.to, prompt: e.prompt?.trim() || undefined })
  }
  return {
    name: draft.name.trim() || 'Loop',
    steps,
    folders,
    links: [...links.values()],
    edges: [...edges.values()],
    start: draft.start && kinds.has(draft.start) ? draft.start : (steps[0]?.id ?? null),
    maxRuns: Math.max(1, Math.min(100, Math.round(draft.maxRuns || DEFAULT_MAX_RUNS))),
    optimize: draft.optimize !== false
  }
}

/** The ways out of a step, numbered for loop_route. */
function routeChoices(l: LoopInfo, out: LoopEdge[]): string {
  return out.map((e, i) => `${i + 1}. ${stepName(l, e.to)}${l.steps.find((s) => s.id === e.to)?.kind === 'human' ? ' (a human review)' : ''}`).join('\n')
}

/** The first message of a step run: the prompt it arrived with, where it sits, its folders, its task, and how the loop goes on. */
export function buildStepPrompt(l: LoopInfo, step: LoopStep, dirs: StepFolders, prompt?: string): string {
  const out = outgoing(l, step.id)
  const parts: string[] = prompt ? [prompt] : []
  parts.push(
    `You are ${stepName(l, step.id)} in the loop "${l.name}", which Symphony runs on this machine. Each step is a separate Claude Code session, and steps share work only through folders.`,
    `<folders>\nInput folder, where you read what you work from: ${dirs.input}\nOutput folder, where you write your results for the steps that read them: ${dirs.output}\n</folders>`,
    `<task>\n${l.optimize === false ? step.prompt : (step.optimized ?? step.prompt)}\n</task>`
  )
  if (!out.length) parts.push('Yours is the last step: when you end your turn, the loop is done.')
  else if (out.length === 1) parts.push(`When you end your turn, the loop moves on to ${stepName(l, out[0].to)}${l.steps.find((s) => s.id === out[0].to)?.kind === 'human' ? ', a human review' : ''}.`)
  else parts.push(`When your work for this step is done, call the loop_route tool once, as your last action, with the number of the step the loop goes to next:\n${routeChoices(l, out)}`)
  return parts.join('\n\n')
}

// ---------- loops saved before loops were graphs ----------

/** A chain of steps on one project. */
interface LinearLoop extends Omit<LoopInfo, 'steps' | 'folders' | 'links' | 'edges' | 'start' | 'current' | 'history'> {
  projectId: string
  steps: Omit<LoopStep, 'position'>[]
  current: number | null
}

/** The project folder becomes every agent step's session folder, and the steps a chain; the old handoffs are dropped. */
function fromLinear(old: LinearLoop, projects: Project[]): LoopInfo {
  const { projectId, ...rest } = old
  const project = projects.find((p) => p.id === projectId)
  const folder: LoopFolder = { id: randomUUID(), name: project?.name ?? 'project', path: project?.path ?? '', position: { x: 0, y: 170 } }
  const steps = old.steps.map((s, i) => ({ ...s, position: { x: i * 260, y: 0 } }))
  return {
    ...rest,
    steps,
    folders: [folder],
    links: steps.filter((s) => s.kind === 'agent').map((s) => ({ stepId: s.id, folderId: folder.id, role: 'session' as const })),
    edges: steps.slice(1).map((s, i) => ({ id: randomUUID(), from: steps[i].id, to: s.id })),
    start: steps[0]?.id ?? null,
    current: old.current === null ? null : (steps[old.current]?.id ?? null),
    history: []
  }
}
