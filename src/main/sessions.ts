// Runs Claude Code sessions through the Agent SDK and turns their message stream into graph state
// (session/agent status) and transcript items. Approvals and AskUserQuestion prompts are held here
// until the user answers them in the session view.
import { query, type CanUseTool, type McpServerConfig, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AgentInfo, ApprovalDecision, AskQuestion, EffortLevel, GhIdentity, ImageInput, MainEvent, NodeStatus, SessionInfo, SessionKind, TranscriptItem } from '@shared/types'
import { claudeExecutable } from './platform'
import { deleteTranscript, loadTranscript, saveTranscript } from './store'
import { keySourceProblem, subscriptionEnv, subscriptionProblem, subscriptionSettings } from './subscription'

/** Close a finished session's Claude Code process after this long without a follow-up; a later follow-up resumes it. */
const IDLE_CLOSE_MS = 10 * 60_000
/** Finished agents stay on the graph this long so their exit is visible. */
const AGENT_LINGER_MS = 1600

interface Pending {
  kind: 'approval' | 'question'
  /** Raised by one of the user's own `ask` permission rules: always asked, even with auto-approve on. */
  forcedAsk?: boolean
  agentId?: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  resolve: (r: PermissionResult) => void
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  /**
   * Text-only messages stay plain strings: Claude Code dispatches slash commands only for those.
   * With images, the content is image blocks followed by the text (Anthropic's recommended order).
   */
  push(text: string, images: ImageInput[] = []): void {
    const content: SDKUserMessage['message']['content'] = images.length
      ? [
          ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
          ...(text.trim() ? [{ type: 'text' as const, text }] : [])
        ]
      : text
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else this.items.push(msg)
  }

  close(): void {
    this.closed = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = null
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.items.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => (this.waiter = r))
      }
    }
  }
}

interface Runtime {
  info: SessionInfo
  items: TranscriptItem[]
  q?: Query
  input?: InputQueue
  env: Record<string, string>
  turnActive: boolean
  pending: Map<string, Pending>
  /** Streaming thinking/text items per parent, in block order, waiting for their final assistant block. */
  live: Map<string, TranscriptItem[]>
  idleTimer?: NodeJS.Timeout
  /** Kept so a resumed process gets the same extra tools. */
  tools?: SessionTools
  /** Resolves true once the process is confirmed to run on the Claude subscription; messages wait for it. */
  ready?: Promise<boolean>
  onResult?: (text: string, isError: boolean) => void
  flushTimer?: NodeJS.Timeout
  dirty: Set<string>
}

export interface StartOptions {
  kind: SessionKind
  anchorId: string
  projectId: string | null
  cwd: string
  prompt: string
  model: string
  effort?: EffortLevel
  title: string
  identity?: GhIdentity
  env?: Record<string, string>
  /** Pasted images sent with the first message. */
  images?: ImageInput[]
  /** Extra tools for this session (a loop step's routing tool), auto-approved by name. */
  tools?: SessionTools
  loopId?: string
  loopStep?: number
  /** Called after every turn's result. */
  onResult?: (text: string, isError: boolean) => void
}

export interface SessionTools {
  mcpServers: Record<string, McpServerConfig>
  allowedTools: string[]
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : c && typeof c === 'object' && (c as { type?: string }).type === 'image' ? '[image]' : ''))
      .join('\n')
  }
  return ''
}

export class SessionManager {
  private runtimes = new Map<string, Runtime>()
  /** While on, permission prompts are allowed without asking. Off at every start of Symphony. */
  private autoApprove = false
  private agents = new Map<string, AgentInfo>()

  constructor(
    private emit: (e: MainEvent) => void,
    private onSessionsChanged: () => void
  ) {}

  /** Re-create sessions from disk after a restart. Their processes are gone, so they show as finished and resume on follow-up. */
  restore(sessions: SessionInfo[]): void {
    for (const info of sessions) {
      if (info.kind === 'optimize') continue
      const status: NodeStatus = 'finished'
      this.runtimes.set(info.id, this.newRuntime({ ...info, status }, {}))
    }
  }

  list(): SessionInfo[] {
    return [...this.runtimes.values()].map((r) => r.info)
  }

  listAgents(): AgentInfo[] {
    return [...this.agents.values()]
  }

  get(id: string): SessionInfo | undefined {
    return this.runtimes.get(id)?.info
  }

  transcript(id: string): TranscriptItem[] {
    const rt = this.runtimes.get(id)
    if (!rt) return []
    if (!rt.items.length) rt.items = loadTranscript(id)
    return rt.items
  }

  private newRuntime(info: SessionInfo, env: Record<string, string>): Runtime {
    return { info, items: [], env, turnActive: false, pending: new Map(), live: new Map(), dirty: new Set() }
  }

  start(opts: StartOptions): SessionInfo {
    const info: SessionInfo = {
      id: randomUUID(),
      kind: opts.kind,
      anchorId: opts.anchorId,
      projectId: opts.projectId,
      cwd: opts.cwd,
      title: opts.title,
      model: opts.model,
      effort: opts.effort,
      status: 'working',
      createdAt: Date.now(),
      identity: opts.identity,
      loopId: opts.loopId,
      loopStep: opts.loopStep
    }
    const rt = this.newRuntime(info, opts.env ?? {})
    rt.onResult = opts.onResult
    rt.tools = opts.tools
    this.runtimes.set(info.id, rt)
    this.emit({ type: 'session', session: info })
    this.onSessionsChanged()
    this.sendTurn(rt, opts.prompt, opts.images)
    return info
  }

  /** Follow-up message from the session view. */
  send(id: string, text: string, images: ImageInput[] = []): void {
    const rt = this.runtimes.get(id)
    if (!rt || (!text.trim() && !images.length)) return
    if (!rt.items.length) rt.items = loadTranscript(id)
    this.sendTurn(rt, text, images)
  }

  setAutoApprove(on: boolean): void {
    this.autoApprove = on
    if (!on) return
    // Release approvals that are already waiting.
    for (const rt of this.runtimes.values()) {
      for (const [requestId, p] of [...rt.pending]) {
        if (p.kind !== 'approval' || p.forcedAsk) continue
        rt.pending.delete(requestId)
        p.resolve({ behavior: 'allow', updatedInput: p.input })
        this.resolveItem(rt, requestId, 'auto')
      }
      this.refreshStatus(rt)
    }
  }

  /** Take an earlier loop-step run off the graph; it stays openable from the loop's history. */
  archive(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt || rt.info.archived) return
    rt.info.archived = true
    this.emitSession(rt)
  }

  /** The pipeline moved on from this optimize session; its node fades out until it is dismissed. */
  markHandedOff(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    rt.info.handedOff = true
    this.emitSession(rt)
  }

  notice(id: string, text: string): void {
    const rt = this.runtimes.get(id)
    if (rt) this.upsert(rt, { kind: 'notice', id: randomUUID(), text })
  }

  async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id)
    if (!rt?.q) return
    for (const [requestId, p] of rt.pending) {
      p.resolve({ behavior: 'deny', message: 'The user stopped the session.', interrupt: true })
      this.resolveItem(rt, requestId, p.kind === 'approval' ? 'deny' : {})
    }
    rt.pending.clear()
    await rt.q.interrupt().catch(() => undefined)
  }

  dismiss(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    this.closeProcess(rt)
    for (const agent of [...this.agents.values()]) if (agent.sessionId === id) this.removeAgent(agent.id)
    this.runtimes.delete(id)
    deleteTranscript(id)
    this.emit({ type: 'sessionRemoved', id })
    this.onSessionsChanged()
  }

  closeAll(): void {
    for (const rt of this.runtimes.values()) this.closeProcess(rt)
  }

  respondApproval(id: string, requestId: string, decision: ApprovalDecision, message?: string): void {
    const rt = this.runtimes.get(id)
    const p = rt?.pending.get(requestId)
    if (!rt || !p || p.kind !== 'approval') return
    rt.pending.delete(requestId)
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: message?.trim() || 'The user declined this action.' })
    else p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: decision === 'always' ? p.suggestions : undefined })
    this.resolveItem(rt, requestId, decision)
    this.refreshStatus(rt)
  }

  respondQuestion(id: string, requestId: string, answers: Record<string, string>): void {
    const rt = this.runtimes.get(id)
    const p = rt?.pending.get(requestId)
    if (!rt || !p || p.kind !== 'question') return
    rt.pending.delete(requestId)
    p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } })
    this.resolveItem(rt, requestId, answers)
    this.refreshStatus(rt)
  }

  // ---------- internals ----------

  private sendTurn(rt: Runtime, text: string, images: ImageInput[] = []): void {
    clearTimeout(rt.idleTimer)
    // The transcript keeps only the thumbnails; the full images go to Claude.
    this.upsert(rt, { kind: 'user', id: randomUUID(), text, images: images.length ? images.map((i) => i.thumb) : undefined })
    rt.turnActive = true
    this.refreshStatus(rt)
    if (!rt.q) {
      this.openProcess(rt)
      rt.ready = this.confirmSubscription(rt)
    }
    const q = rt.q
    // Nothing reaches the model until the login is confirmed to be the subscription.
    void rt.ready!.then((ok) => {
      if (ok && rt.q === q) rt.input!.push(text, images)
    })
  }

  private async confirmSubscription(rt: Runtime): Promise<boolean> {
    const q = rt.q!
    let problem: string | null
    try {
      problem = await subscriptionProblem(q)
    } catch (err) {
      problem = `Could not confirm that Claude Code is using your subscription: ${(err as Error).message}`
    }
    if (problem && rt.q === q) this.refuse(rt, problem)
    return !problem
  }

  /** Stop a session that would not run on the subscription, and say why in its transcript. */
  private refuse(rt: Runtime, reason: string): void {
    this.closeProcess(rt)
    for (const p of rt.pending.values()) p.resolve({ behavior: 'deny', message: reason, interrupt: true })
    rt.pending.clear()
    rt.turnActive = false
    this.finishLive(rt)
    for (const agent of [...this.agents.values()]) if (agent.sessionId === rt.info.id) this.removeAgent(agent.id)
    this.upsert(rt, { kind: 'notice', id: randomUUID(), text: reason })
    this.refreshStatus(rt)
  }

  private openProcess(rt: Runtime): void {
    const input = new InputQueue()
    rt.input = input
    const canUseTool: CanUseTool = (toolName, toolInput, opts) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = opts.requestId || randomUUID()
        const isQuestion = toolName === 'AskUserQuestion'
        const parent = opts.agentID ? (this.agents.get(opts.agentID)?.toolUseId ?? null) : null
        const approvalItem = {
          kind: 'approval' as const,
          id: requestId,
          toolName,
          input: toolInput,
          title: opts.title,
          description: opts.description,
          parent,
          agentId: opts.agentID,
          canAlwaysAllow: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule
        }
        // Auto-approve: allow at once, but keep a record. Questions still need an answer, and prompts
        // forced by the user's own ask rules are still asked.
        if (!isQuestion && this.autoApprove && !opts.matchedAskRule) {
          this.upsert(rt, { ...approvalItem, resolved: 'auto' })
          resolve({ behavior: 'allow', updatedInput: toolInput })
          return
        }
        rt.pending.set(requestId, { kind: isQuestion ? 'question' : 'approval', forcedAsk: !!opts.matchedAskRule, agentId: opts.agentID, input: toolInput, suggestions: opts.suggestions, resolve })
        if (isQuestion) {
          this.upsert(rt, { kind: 'question', id: requestId, questions: (toolInput.questions as AskQuestion[]) ?? [], parent, agentId: opts.agentID })
        } else {
          this.upsert(rt, approvalItem)
        }
        opts.signal.addEventListener('abort', () => {
          if (!rt.pending.delete(requestId)) return
          this.resolveItem(rt, requestId, isQuestion ? {} : 'deny')
          this.refreshStatus(rt)
        })
        this.refreshStatus(rt)
      })

    const q = query({
      prompt: input,
      options: {
        cwd: rt.info.cwd,
        model: rt.info.model,
        effort: rt.info.effort,
        resume: rt.info.sdkSessionId,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        pathToClaudeCodeExecutable: claudeExecutable(),
        includePartialMessages: true,
        forwardSubagentText: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        permissionMode: 'default',
        canUseTool,
        mcpServers: rt.tools?.mcpServers,
        allowedTools: rt.tools?.allowedTools,
        env: subscriptionEnv(process.env, { ...rt.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'symphony/0.1.0' }),
        settings: subscriptionSettings,
        stderr: (data) => console.error(`[claude ${rt.info.id.slice(0, 8)}]`, data.trimEnd())
      }
    })
    rt.q = q
    void this.pump(rt, q)
  }

  private async pump(rt: Runtime, q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(rt, msg)
    } catch (err) {
      if (rt.q === q) this.upsert(rt, { kind: 'notice', id: randomUUID(), text: `Claude Code stopped: ${(err as Error).message}` })
    } finally {
      if (rt.q === q) {
        rt.q = undefined
        rt.input = undefined
        rt.turnActive = false
        for (const p of rt.pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed.' })
        rt.pending.clear()
        this.finishLive(rt)
        for (const agent of [...this.agents.values()]) if (agent.sessionId === rt.info.id) this.removeAgent(agent.id)
        if (this.runtimes.has(rt.info.id)) this.refreshStatus(rt)
      }
    }
  }

  private closeProcess(rt: Runtime): void {
    clearTimeout(rt.idleTimer)
    const q = rt.q
    rt.q = undefined
    rt.input?.close()
    rt.input = undefined
    q?.close()
  }

  private handle(rt: Runtime, msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        this.handleSystem(rt, msg)
        break
      case 'stream_event':
        this.handleStream(rt, msg.event as unknown as StreamEvent, msg.parent_tool_use_id)
        break
      case 'assistant':
        for (const block of msg.message.content as unknown as ContentBlock[]) this.handleAssistantBlock(rt, block, msg.parent_tool_use_id)
        break
      case 'user':
        this.handleUser(rt, msg)
        break
      case 'result': {
        rt.turnActive = false
        this.finishLive(rt)
        const isError = msg.subtype !== 'success' || !!msg.is_error
        const text = msg.subtype === 'success' ? msg.result : `Ended with ${msg.subtype.replace(/_/g, ' ')}`
        this.upsert(rt, { kind: 'result', id: msg.uuid, text, isError, costUsd: msg.total_cost_usd, durationMs: msg.duration_ms })
        this.refreshStatus(rt)
        rt.idleTimer = setTimeout(() => this.closeProcess(rt), IDLE_CLOSE_MS)
        rt.onResult?.(text, isError)
        break
      }
    }
  }

  private handleSystem(rt: Runtime, msg: Extract<SDKMessage, { type: 'system' }>): void {
    if (msg.subtype === 'init') {
      const problem = keySourceProblem(msg.apiKeySource)
      if (problem) return this.refuse(rt, problem)
      if (rt.info.sdkSessionId !== msg.session_id) {
        rt.info.sdkSessionId = msg.session_id
        this.emitSession(rt)
      }
    } else if (msg.subtype === 'task_started') {
      if (msg.ambient || msg.skip_transcript) return
      if (msg.task_type && msg.task_type !== 'local_agent') return
      const agent: AgentInfo = {
        id: msg.task_id,
        sessionId: rt.info.id,
        toolUseId: msg.tool_use_id,
        description: msg.description,
        subagentType: msg.subagent_type,
        status: 'working'
      }
      this.agents.set(agent.id, agent)
      this.emit({ type: 'agent', agent })
    } else if (msg.subtype === 'task_notification') {
      this.finishAgent(msg.task_id)
    } else if (msg.subtype === 'task_updated') {
      const s = msg.patch.status
      if (s === 'completed' || s === 'failed' || s === 'killed') this.finishAgent(msg.task_id)
    }
  }

  private finishAgent(taskId: string): void {
    const agent = this.agents.get(taskId)
    if (!agent || agent.status === 'finished') return
    agent.status = 'finished'
    this.emit({ type: 'agent', agent: { ...agent } })
    setTimeout(() => this.removeAgent(taskId), AGENT_LINGER_MS)
  }

  private removeAgent(id: string): void {
    if (this.agents.delete(id)) this.emit({ type: 'agentRemoved', id })
  }

  private handleStream(rt: Runtime, ev: StreamEvent, parent: string | null): void {
    const key = parent ?? ''
    if (ev.type === 'content_block_start') {
      const t = ev.content_block?.type
      if (t !== 'thinking' && t !== 'text') return
      const item: TranscriptItem = { kind: t, id: `live-${randomUUID()}`, text: '', parent, live: true }
      const queue = rt.live.get(key) ?? []
      queue.push(item)
      rt.live.set(key, queue)
      this.upsert(rt, item)
    } else if (ev.type === 'content_block_delta') {
      const queue = rt.live.get(key)
      const item = queue?.[queue.length - 1]
      if (!item || (item.kind !== 'thinking' && item.kind !== 'text')) return
      const piece = ev.delta?.type === 'thinking_delta' ? ev.delta.thinking : ev.delta?.type === 'text_delta' ? ev.delta.text : undefined
      if (!piece) return
      item.text += piece
      this.markDirty(rt, item.id)
    }
  }

  private handleAssistantBlock(rt: Runtime, block: ContentBlock, parent: string | null): void {
    if (block.type === 'thinking' || block.type === 'text') {
      const full = block.type === 'thinking' ? (block.thinking ?? '') : (block.text ?? '')
      const queue = rt.live.get(parent ?? '')
      const idx = queue?.findIndex((i) => i.kind === block.type) ?? -1
      if (queue && idx >= 0) {
        const [item] = queue.splice(idx, 1)
        if (item.kind === 'thinking' || item.kind === 'text') {
          item.text = full || item.text
          item.live = false
          this.upsert(rt, item)
        }
      } else if (full.trim()) {
        this.upsert(rt, { kind: block.type, id: randomUUID(), text: full, parent })
      }
    } else if (block.type === 'tool_use' && block.id) {
      this.upsert(rt, { kind: 'tool', id: block.id, name: block.name ?? 'tool', input: (block.input as Record<string, unknown>) ?? {}, parent })
    }
  }

  private handleUser(rt: Runtime, msg: Extract<SDKMessage, { type: 'user' }>): void {
    const content = msg.message.content
    if (!Array.isArray(content)) return
    for (const block of content as unknown as ContentBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const item = rt.items.find((i) => i.id === block.tool_use_id)
      if (item?.kind !== 'tool') continue
      item.result = { text: toolResultText(block.content), isError: !!block.is_error }
      this.upsert(rt, item)
    }
  }

  /** Live items that never got their final block (interrupted turn) keep their streamed text. */
  private finishLive(rt: Runtime): void {
    for (const queue of rt.live.values()) {
      for (const item of queue) {
        if (item.kind === 'thinking' || item.kind === 'text') {
          item.live = false
          this.upsert(rt, item)
        }
      }
    }
    rt.live.clear()
  }

  private resolveItem(rt: Runtime, requestId: string, resolution: ApprovalDecision | 'auto' | Record<string, string>): void {
    const item = rt.items.find((i) => i.id === requestId)
    if (item?.kind === 'approval' && typeof resolution === 'string') item.resolved = resolution
    else if (item?.kind === 'question' && typeof resolution === 'object') item.resolved = resolution
    else return
    this.upsert(rt, item)
  }

  private refreshStatus(rt: Runtime): void {
    const pending = [...rt.pending.values()]
    const status: NodeStatus = pending.some((p) => p.kind === 'approval')
      ? 'approval'
      : pending.some((p) => p.kind === 'question')
        ? 'input'
        : rt.turnActive
          ? 'working'
          : 'finished'
    if (status !== rt.info.status) {
      rt.info.status = status
      this.emitSession(rt)
    }
    for (const agent of this.agents.values()) {
      if (agent.sessionId !== rt.info.id || agent.status === 'finished') continue
      const mine = pending.filter((p) => p.agentId === agent.id)
      const next: NodeStatus = mine.some((p) => p.kind === 'approval') ? 'approval' : mine.some((p) => p.kind === 'question') ? 'input' : 'working'
      if (next !== agent.status) {
        agent.status = next
        this.emit({ type: 'agent', agent: { ...agent } })
      }
    }
  }

  private emitSession(rt: Runtime): void {
    this.emit({ type: 'session', session: { ...rt.info } })
    this.onSessionsChanged()
  }

  private upsert(rt: Runtime, item: TranscriptItem): void {
    const idx = rt.items.findIndex((i) => i.id === item.id)
    if (idx >= 0) rt.items[idx] = item
    else rt.items.push(item)
    rt.dirty.delete(item.id)
    this.emit({ type: 'transcript', sessionId: rt.info.id, item: structuredClone(item) })
    saveTranscript(rt.info.id, rt.items)
  }

  /** Streaming deltas are batched so the renderer gets ~20 updates a second, not one per token. */
  private markDirty(rt: Runtime, itemId: string): void {
    rt.dirty.add(itemId)
    if (rt.flushTimer) return
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = undefined
      for (const id of rt.dirty) {
        const item = rt.items.find((i) => i.id === id)
        if (item) this.emit({ type: 'transcript', sessionId: rt.info.id, item: structuredClone(item) })
      }
      rt.dirty.clear()
    }, 50)
  }
}

interface StreamEvent {
  type: string
  content_block?: { type: string }
  delta?: { type: string; thinking?: string; text?: string }
}

interface ContentBlock {
  type: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  thinking?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
