// The orchestrator's copy of one remote machine: its last snapshot kept current by its events,
// the routing table of the IDs it owns, the transcripts fetched from it, and the transform into
// what this machine's renderer sees (machineId set, repeating IDs prefixed, positions from this
// machine's own layout, remote usage dropped). Plain logic, no sockets, so it can be tested alone.
import { repeatsAcrossMachines, withMachine } from '@shared/remote'
import { USER_HUB_ID, type AppSnapshot, type LoopInfo, type MainEvent, type McpInfo, type Point, type Project, type SessionInfo, type SkillInfo, type TranscriptItem } from '@shared/types'

/** Transcripts kept per machine, most recently fetched. */
export const TRANSCRIPTS_KEPT = 20

export interface MirrorOut {
  /** An event for this machine's renderer, already transformed. */
  emit(e: MainEvent): void
  /** A sequence gap: ask the machine for a fresh snapshot. */
  resync(): void
  /** Per-machine settings changed (GitHub accounts, models, auto-approve). */
  machineChanged(): void
  /** Something worth saving changed. */
  changed(): void
}

export interface SavedMirror {
  snapshot: AppSnapshot | null
  transcripts: [string, TranscriptItem[]][]
}

/** Apply one event to a raw (untransformed) snapshot. Returns false for events that carry no state. */
export function applyEvent(s: AppSnapshot, e: MainEvent): boolean {
  const upsert = <T extends { id: string }>(list: T[], item: T, merge = false) => {
    const i = list.findIndex((x) => x.id === item.id)
    if (i < 0) list.push(item)
    else list[i] = merge ? { ...list[i], ...item } : item
  }
  switch (e.type) {
    case 'project':
      upsert(s.projects, e.project)
      return true
    case 'projectRemoved':
      s.projects = s.projects.filter((p) => p.id !== e.id)
      delete s.git[e.id]
      return true
    case 'session':
      upsert(s.sessions, e.session, true)
      return true
    case 'sessionRemoved':
      s.sessions = s.sessions.filter((x) => x.id !== e.id)
      return true
    case 'agent':
      upsert(s.agents, e.agent)
      return true
    case 'agentRemoved':
      s.agents = s.agents.filter((a) => a.id !== e.id)
      return true
    case 'git':
      s.git[e.projectId] = e.stats
      return true
    case 'config':
      s.skills = e.skills
      s.mcp = e.mcp
      return true
    case 'gh':
      s.gh = e.gh
      return true
    case 'models':
      s.models = e.models
      return true
    case 'autoApprove':
      s.autoApprove = e.on
      return true
    case 'loop':
      upsert(s.loops, e.loop)
      return true
    case 'loopRemoved':
      s.loops = s.loops.filter((l) => l.id !== e.id)
      return true
    default:
      return false
  }
}

export class MachineMirror {
  snapshot: AppSnapshot | null = null
  /** The last event applied. */
  seq = 0
  /** Waiting for a snapshot; events are buffered until it arrives. */
  syncing = true
  private buffer: { seq: number; event: MainEvent }[] = []
  /** The routing table: project, session and loop IDs this machine owns. */
  private owned = new Set<string>()
  private transcripts = new Map<string, TranscriptItem[]>()
  /** The event seq each cached transcript reflects. */
  private transcriptSeq = new Map<string, number>()

  constructor(
    readonly id: string,
    /** This machine's layout of the remote nodes (owned and saved by the orchestrator). */
    private layout: () => Record<string, Point>,
    private machinePosition: () => Point,
    private out: MirrorOut
  ) {}

  // ---------- intake ----------

  /** The link came back (or a gap was found): buffer events until the next snapshot. */
  beginSync(): void {
    this.syncing = true
    this.buffer = []
  }

  onSnapshot(raw: AppSnapshot, seq: number): void {
    this.snapshot = clean(raw)
    this.seq = seq
    this.rebuildRoutes()
    this.pruneLayout()
    this.syncing = false
    const buffered = this.buffer
    this.buffer = []
    // Events already reflected in the snapshot are dropped, so nothing is applied twice.
    for (const b of buffered) if (b.seq > seq) this.onEvent(b.seq, b.event)
    this.out.changed()
  }

  onEvent(seq: number, e: MainEvent): void {
    if (this.syncing) {
      this.buffer.push({ seq, event: e })
      return
    }
    if (seq <= this.seq) return
    if (seq !== this.seq + 1) {
      this.beginSync()
      this.buffer.push({ seq, event: e })
      this.out.resync()
      return
    }
    this.seq = seq
    this.apply(e)
  }

  /** A fetched transcript; `seq` is the last event it reflects. Later events update it by item id. */
  onTranscript(sessionId: string, items: TranscriptItem[], seq: number): void {
    this.transcripts.delete(sessionId)
    this.transcripts.set(sessionId, structuredClone(items))
    this.transcriptSeq.set(sessionId, seq)
    while (this.transcripts.size > TRANSCRIPTS_KEPT) {
      const oldest = this.transcripts.keys().next().value!
      this.transcripts.delete(oldest)
      this.transcriptSeq.delete(oldest)
    }
    this.out.changed()
  }

  cachedTranscript(sessionId: string): TranscriptItem[] | null {
    return this.transcripts.get(sessionId) ?? null
  }

  private apply(e: MainEvent): void {
    const s = this.snapshot
    if (!s) return
    if (e.type === 'usage' || e.type === 'control' || e.type === 'machine' || e.type === 'machineRemoved' || e.type === 'remote' || e.type === 'snapshot') return
    if (e.type === 'transcript') this.updateTranscript(e.sessionId, e.item)
    if (applyEvent(s, e)) {
      this.trackRoutes(e)
      this.out.changed()
    }
    if (e.type === 'gh' || e.type === 'models' || e.type === 'autoApprove') return this.out.machineChanged()
    const pc = this.toPc(e)
    if (pc) this.out.emit(pc)
  }

  private updateTranscript(sessionId: string, item: TranscriptItem): void {
    const list = this.transcripts.get(sessionId)
    if (!list || this.seq <= (this.transcriptSeq.get(sessionId) ?? 0)) return
    const i = list.findIndex((x) => x.id === item.id)
    if (i >= 0) list[i] = item
    else list.push(item)
  }

  // ---------- routing ----------

  owns(id: string): boolean {
    return this.owned.has(id)
  }

  private rebuildRoutes(): void {
    const s = this.snapshot!
    this.owned = new Set([...s.projects.map((p) => p.id), ...s.sessions.map((x) => x.id), ...s.loops.map((l) => l.id)])
  }

  private trackRoutes(e: MainEvent): void {
    if (e.type === 'project') this.owned.add(e.project.id)
    else if (e.type === 'session') this.owned.add(e.session.id)
    else if (e.type === 'loop') this.owned.add(e.loop.id)
    else if (e.type === 'projectRemoved' || e.type === 'sessionRemoved' || e.type === 'loopRemoved') {
      this.owned.delete(e.id)
      delete this.layout()[e.id]
    }
  }

  // ---------- the orchestrator's view ----------

  hubId(): string {
    return withMachine(this.id, USER_HUB_ID)
  }

  hubPosition(): Point {
    const m = this.machinePosition()
    return this.layout()[this.hubId()] ?? { x: m.x, y: m.y + 200 }
  }

  /** Projects, sessions, loops, skills and MCP servers as this machine's renderer sees them. */
  view(): Pick<AppSnapshot, 'projects' | 'sessions' | 'agents' | 'skills' | 'mcp' | 'git' | 'loops'> {
    const s = this.snapshot
    if (!s) return { projects: [], sessions: [], agents: [], skills: [], mcp: [], git: {}, loops: [] }
    return {
      projects: s.projects.map((p) => this.project(p)),
      sessions: s.sessions.map((x) => this.session(x)),
      agents: s.agents,
      skills: s.skills.map((k) => this.skill(k)),
      mcp: s.mcp.map((m) => this.mcp(m)),
      git: s.git,
      loops: s.loops.map((l) => this.loop(l))
    }
  }

  project(p: Project): Project {
    const index = Math.max(0, this.snapshot?.projects.findIndex((x) => x.id === p.id) ?? 0)
    const m = this.machinePosition()
    const fallback = { x: m.x + 680 + (index % 3) * 560, y: m.y + 40 + Math.floor(index / 3) * 420 }
    return { ...p, machineId: this.id, position: this.layout()[p.id] ?? fallback }
  }

  session(x: SessionInfo): SessionInfo {
    // The machine's own positions are ignored here; without one of ours the graph places it by its anchor.
    return { ...x, machineId: this.id, anchorId: this.prefixed(x.anchorId), position: this.layout()[x.id] }
  }

  loop(l: LoopInfo): LoopInfo {
    return { ...l, machineId: this.id, position: this.layout()[l.id] }
  }

  skill(k: SkillInfo): SkillInfo {
    return { ...k, id: withMachine(this.id, k.id), machineId: this.id }
  }

  mcp(m: McpInfo): McpInfo {
    return { ...m, id: withMachine(this.id, m.id), machineId: this.id }
  }

  private prefixed(id: string): string {
    return repeatsAcrossMachines(id) ? withMachine(this.id, id) : id
  }

  /** One remote event as this machine's renderer needs it, or null when it is not passed on. */
  toPc(e: MainEvent): MainEvent | null {
    switch (e.type) {
      case 'project':
        return { type: 'project', project: this.project(e.project) }
      case 'session':
        return { type: 'session', session: this.session(e.session) }
      case 'loop':
        return { type: 'loop', loop: this.loop(e.loop) }
      case 'config':
        return { type: 'config', skills: e.skills.map((k) => this.skill(k)), mcp: e.mcp.map((m) => this.mcp(m)), machineId: this.id }
      case 'login':
        return { ...e, machineId: this.id }
      case 'term':
      case 'termExit':
        return { ...e, id: withMachine(this.id, e.id) }
      case 'projectRemoved':
      case 'sessionRemoved':
      case 'agent':
      case 'agentRemoved':
      case 'transcript':
      case 'git':
      case 'focus':
      case 'loopRemoved':
        return e
      default:
        // usage (only this machine's own is shown), gh/models/autoApprove (machine state), control, snapshot
        return null
    }
  }

  // ---------- layout and persistence ----------

  /** Forget positions of remote nodes that no longer exist. */
  private pruneLayout(): void {
    const layout = this.layout()
    const keep = new Set([...this.owned, this.hubId(), `machine:${this.id}`])
    for (const key of Object.keys(layout)) if (!keep.has(key)) delete layout[key]
  }

  toJSON(): SavedMirror {
    return { snapshot: this.snapshot, transcripts: [...this.transcripts.entries()] }
  }

  restore(saved: SavedMirror): void {
    if (saved.snapshot) {
      this.snapshot = clean(saved.snapshot)
      this.rebuildRoutes()
    }
    for (const [id, items] of saved.transcripts ?? []) this.transcripts.set(id, items)
  }
}

/**
 * A remote snapshot without the fields this machine never takes from another: usage, machines,
 * control. Loops saved before loops were graphs are left out; the machine sends them converted.
 */
function clean(s: AppSnapshot): AppSnapshot {
  const c = structuredClone(s)
  return { ...c, usage: null, machines: [], control: null, loops: c.loops.filter((l) => Array.isArray(l.edges)) }
}
