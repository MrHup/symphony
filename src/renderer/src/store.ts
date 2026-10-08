import { create } from 'zustand'
import { splitMachine, withMachine } from '@shared/remote'
import {
  USER_HUB_ID,
  type AgentInfo,
  type AppSnapshot,
  type AssetRef,
  type ControlState,
  type EffortLevel,
  type GhAccounts,
  type GitStats,
  type LoginPrompt,
  type LoopInfo,
  type MachineState,
  type MainEvent,
  type McpInfo,
  type ModelOption,
  type NodeStatus,
  type Point,
  type Project,
  type RemoteStatus,
  type SessionInfo,
  type SkillInfo,
  type TranscriptItem,
  type UsageInfo
} from '@shared/types'

export const api = window.symphony

export type PanelKind = 'session' | 'agent' | 'diff' | 'skill' | 'mcp' | 'claudemd' | 'login' | 'terminal' | 'usage' | 'loop' | 'remote' | 'folders' | 'pairing' | 'needs'

export interface Panel {
  id: string
  kind: PanelKind
  targetId: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface Composer {
  kind: 'project' | 'skill' | 'mcp'
  targetId: string
  /** Screen rectangle of the node it points at. */
  left: number
  right: number
  top: number
}

interface State {
  ready: boolean
  projects: Record<string, Project>
  sessions: Record<string, SessionInfo>
  agents: Record<string, AgentInfo>
  skills: SkillInfo[]
  mcp: McpInfo[]
  git: Record<string, GitStats>
  hubPosition: Point
  /** Hubs the user folded away, by hub node id. */
  hubClosed: Record<string, boolean>
  gh: GhAccounts
  models: ModelOption[]
  defaultModel: string
  efforts: Record<string, EffortLevel>
  usage: UsageInfo | null
  loops: Record<string, LoopInfo>
  autoApprove: boolean
  /** Remote machines (on an orchestrator). */
  machines: Record<string, MachineState>
  machinePosition: Point
  /** Set while another machine controls this one: the window is read-only. */
  control: ControlState | null
  remote: RemoteStatus | null
  /** When each session or loop started waiting for you. */
  waitingSince: Record<string, number>
  transcripts: Record<string, TranscriptItem[]>
  /** GitHub sign-in prompts, by machine ('local' for this one). */
  logins: Record<string, LoginPrompt>
  panels: Panel[]
  composer: Composer | null
  /** The image viewer: images of one session or loop, and the one shown. */
  lightbox: { ownerId: string; files: AssetRef[]; index: number } | null
  apply(e: MainEvent): void
  load(s: AppSnapshot): void
  openPanel(kind: PanelKind, targetId: string): void
  closePanel(id: string): void
  raisePanel(id: string): void
  updatePanel(id: string, patch: Partial<Panel>): void
  setComposer(c: Composer | null): void
  setLightbox(l: State['lightbox']): void
  toggleHub(id: string): void
  setDefaultModel(model: string, machineId?: string): void
  setModelEffort(model: string, effort: EffortLevel | null, machineId?: string): void
  /** Open a new terminal in a project's folder, or a machine's home folder when projectId is null. */
  openTerminal(projectId: string | null, machineId?: string): void
  /** Open the loop editor for a new loop on a project. */
  newLoop(projectId: string): void
  /** Fetch a transcript once; `force` fetches it again (after a remote machine resyncs). */
  loadTranscript(sessionId: string, force?: boolean): Promise<void>
}

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]))
const omit = <T>(rec: Record<string, T>, id: string) => {
  const next = { ...rec }
  delete next[id]
  return next
}

let zTop = 10

const PANEL_SIZES: Record<PanelKind, { w: number; h: number }> = {
  session: { w: 620, h: 720 },
  agent: { w: 560, h: 560 },
  diff: { w: 1180, h: 720 },
  skill: { w: 760, h: 680 },
  mcp: { w: 620, h: 560 },
  claudemd: { w: 820, h: 700 },
  login: { w: 380, h: 250 },
  terminal: { w: 820, h: 460 },
  loop: { w: 720, h: 760 },
  usage: { w: 400, h: 300 },
  remote: { w: 560, h: 720 },
  folders: { w: 520, h: 560 },
  pairing: { w: 380, h: 300 },
  needs: { w: 460, h: 420 }
}

let terminalCount = 0

const isUp = (m: MachineState | undefined) => !!m && (m.status === 'online' || m.status === 'reconnecting')
const waiting = (s: NodeStatus) => s === 'approval' || s === 'input'

// ---------- control: read-only while another machine is connected ----------

let latestControl: ControlState | null = null
let controlWait: (() => void) | null = null

/**
 * When control comes back while the person here is typing, wait until the field loses focus (or
 * 30 s) before turning read-only, so the text is not lost.
 */
function applyControl(control: ControlState | null): void {
  latestControl = control
  if (controlWait) return
  const s = useStore.getState()
  const el = document.activeElement as HTMLElement | null
  const typing = !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text') || el.isContentEditable)
  if (control && !s.control && typing) {
    const done = () => {
      el.removeEventListener('blur', done)
      clearTimeout(timer)
      controlWait = null
      useStore.setState({ control: latestControl })
    }
    const timer = setTimeout(done, 30_000)
    el.addEventListener('blur', done)
    controlWait = done
    return
  }
  useStore.setState({ control })
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: {},
  sessions: {},
  agents: {},
  skills: [],
  mcp: [],
  git: {},
  hubPosition: { x: -420, y: 0 },
  hubClosed: {},
  gh: { installed: false, hosts: {} },
  models: [],
  defaultModel: 'opus',
  efforts: {},
  usage: null,
  loops: {},
  autoApprove: false,
  machines: {},
  machinePosition: { x: -420, y: -200 },
  control: null,
  remote: null,
  waitingSince: {},
  transcripts: {},
  logins: {},
  panels: [],
  composer: null,
  lightbox: null,

  load(s) {
    const prev = get().waitingSince
    const now = Date.now()
    const waitingSince: Record<string, number> = {}
    for (const x of s.sessions) if (waiting(x.status)) waitingSince[x.id] = prev[x.id] ?? now
    for (const l of s.loops ?? []) if (l.state === 'waiting' || l.state === 'paused') waitingSince[l.id] = prev[l.id] ?? now
    set({
      ready: true,
      projects: byId(s.projects),
      sessions: byId(s.sessions),
      agents: byId(s.agents),
      skills: s.skills,
      mcp: s.mcp,
      git: s.git,
      hubPosition: s.hubPosition,
      gh: s.gh,
      models: s.models,
      defaultModel: s.defaultModel,
      efforts: s.efforts ?? {},
      usage: s.usage,
      loops: byId(s.loops ?? []),
      autoApprove: !!s.autoApprove,
      machines: byId(s.machines ?? []),
      machinePosition: s.machinePosition ?? { x: s.hubPosition.x, y: s.hubPosition.y - 200 },
      waitingSince
    })
    applyControl(s.control ?? null)
  },

  apply(e) {
    switch (e.type) {
      case 'snapshot':
        get().load(e.snapshot)
        break
      case 'project':
        set((s) => ({ projects: { ...s.projects, [e.project.id]: e.project } }))
        break
      case 'projectRemoved':
        set((s) => ({ projects: omit(s.projects, e.id), panels: s.panels.filter((p) => p.targetId !== e.id) }))
        break
      case 'session':
        set((s) => {
          const was = s.waitingSince[e.session.id]
          const now = waiting(e.session.status)
          const waitingSince = now && !was ? { ...s.waitingSince, [e.session.id]: Date.now() } : !now && was ? omit(s.waitingSince, e.session.id) : s.waitingSince
          return { sessions: { ...s.sessions, [e.session.id]: { ...s.sessions[e.session.id], ...e.session } }, waitingSince }
        })
        break
      case 'sessionRemoved':
        set((s) => ({
          sessions: omit(s.sessions, e.id),
          transcripts: omit(s.transcripts, e.id),
          waitingSince: omit(s.waitingSince, e.id),
          panels: s.panels.filter((p) => !(p.kind === 'session' && p.targetId === e.id))
        }))
        break
      case 'agent':
        set((s) => ({ agents: { ...s.agents, [e.agent.id]: e.agent } }))
        break
      case 'agentRemoved':
        set((s) => ({ agents: omit(s.agents, e.id) }))
        break
      case 'transcript':
        set((s) => {
          const list = s.transcripts[e.sessionId]
          if (!list) return {}
          const idx = list.findIndex((i) => i.id === e.item.id)
          const next = idx >= 0 ? list.map((i, n) => (n === idx ? e.item : i)) : [...list, e.item]
          return { transcripts: { ...s.transcripts, [e.sessionId]: next } }
        })
        break
      case 'git':
        set((s) => ({ git: { ...s.git, [e.projectId]: e.stats } }))
        break
      case 'config':
        // Each machine's skills and MCP servers are replaced separately.
        set((s) => ({
          skills: [...s.skills.filter((k) => k.machineId !== e.machineId), ...e.skills],
          mcp: [...s.mcp.filter((m) => m.machineId !== e.machineId), ...e.mcp]
        }))
        break
      case 'gh':
        set({ gh: e.gh })
        break
      case 'login':
        set((s) => ({ logins: { ...s.logins, [e.machineId ?? 'local']: e.prompt } }))
        break
      case 'models':
        set({ models: e.models })
        break
      case 'focus':
        get().openPanel('session', e.sessionId)
        break
      case 'usage':
        set({ usage: e.usage })
        break
      case 'loop':
        set((s) => {
          const now = e.loop.state === 'waiting' || e.loop.state === 'paused'
          const was = s.waitingSince[e.loop.id]
          const waitingSince = now && !was ? { ...s.waitingSince, [e.loop.id]: Date.now() } : !now && was ? omit(s.waitingSince, e.loop.id) : s.waitingSince
          return { loops: { ...s.loops, [e.loop.id]: e.loop }, waitingSince }
        })
        break
      case 'autoApprove':
        set({ autoApprove: e.on })
        break
      case 'loopRemoved':
        set((s) => ({ loops: omit(s.loops, e.id), waitingSince: omit(s.waitingSince, e.id), panels: s.panels.filter((p) => !(p.kind === 'loop' && p.targetId === e.id)) }))
        break
      case 'term':
      case 'termExit':
        terminalBus.deliver(e)
        break
      case 'machine': {
        const before = get().machines[e.machine.id]
        set((s) => ({ machines: { ...s.machines, [e.machine.id]: e.machine } }))
        // Back online after a gap: transcripts of its sessions are fetched again, so nothing stale remains.
        if (e.machine.status === 'online' && before && before.status !== 'online') {
          for (const id of Object.keys(get().transcripts)) if (get().sessions[id]?.machineId === e.machine.id) void get().loadTranscript(id, true)
        }
        break
      }
      case 'machineRemoved':
        set((s) => {
          const mine = <T extends { machineId?: string }>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([, v]) => v.machineId !== e.id))
          const sessions = mine(s.sessions)
          const projects = mine(s.projects)
          const loops = mine(s.loops)
          const agents = Object.fromEntries(Object.entries(s.agents).filter(([, a]) => !!sessions[a.sessionId] || !s.sessions[a.sessionId]))
          const otherMachine = (id: string) => splitMachine(id)?.machineId !== e.id
          const keep = (p: Panel): boolean => {
            switch (p.kind) {
              case 'session':
                return !!sessions[p.targetId]
              case 'agent':
                return !!agents[p.targetId]
              case 'loop':
                return p.targetId.startsWith('new:') ? !!projects[p.targetId.slice(4).split('#')[0]] : !!loops[p.targetId]
              case 'diff':
              case 'claudemd':
                return !!projects[p.targetId]
              case 'skill':
              case 'mcp':
                return otherMachine(p.targetId)
              case 'terminal': {
                const where = p.targetId.split('#')[0]
                return otherMachine(where) && (where === 'home' || splitMachine(where) !== null || !!projects[where])
              }
              case 'folders':
              case 'pairing':
              case 'login':
                return p.targetId !== e.id
              default:
                return true
            }
          }
          return {
            machines: omit(s.machines, e.id),
            projects,
            sessions,
            loops,
            agents,
            skills: s.skills.filter((k) => k.machineId !== e.id),
            mcp: s.mcp.filter((m) => m.machineId !== e.id),
            panels: s.panels.filter(keep)
          }
        })
        break
      case 'control':
        applyControl(e.control)
        break
      case 'remote':
        set({ remote: e.status })
        break
    }
  },

  openPanel(kind, targetId) {
    const existing = get().panels.find((p) => p.kind === kind && p.targetId === targetId)
    if (existing) return get().raisePanel(existing.id)
    const size = PANEL_SIZES[kind]
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = Math.min(size.w, vw - 40)
    const h = Math.min(size.h, vh - 80)
    const offset = (get().panels.length % 5) * 28
    const x = kind === 'session' || kind === 'agent' ? vw - w - 24 - offset : Math.max(20, (vw - w) / 2 + offset)
    const y = Math.max(48, (vh - h) / 2 + offset - 10)
    if (kind === 'session' || kind === 'agent') void get().loadTranscript(kind === 'agent' ? (get().agents[targetId]?.sessionId ?? '') : targetId)
    set((s) => ({ panels: [...s.panels, { id: `${kind}:${targetId}`, kind, targetId, x, y, w, h, z: ++zTop }] }))
  },

  closePanel(id) {
    set((s) => ({ panels: s.panels.filter((p) => p.id !== id) }))
  },

  raisePanel(id) {
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, z: ++zTop } : p)) }))
  },

  updatePanel(id, patch) {
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  },

  setComposer(c) {
    set({ composer: c })
  },

  setLightbox(l) {
    set({ lightbox: l })
  },

  toggleHub(id) {
    set((s) => ({ hubClosed: { ...s.hubClosed, [id]: !s.hubClosed[id] } }))
  },

  setDefaultModel(model, machineId) {
    const m = machineId ? get().machines[machineId] : undefined
    if (m) set((s) => ({ machines: { ...s.machines, [m.id]: { ...m, defaultModel: model } } }))
    else set({ defaultModel: model })
    void api.setDefaultModel(model, machineId)
  },

  newLoop(projectId) {
    get().openPanel('loop', `new:${projectId}#${++terminalCount}`)
  },

  openTerminal(projectId, machineId) {
    // Each terminal gets its own panel, so a project can have several.
    const where = projectId ?? (machineId ? withMachine(machineId, 'home') : 'home')
    get().openPanel('terminal', `${where}#${++terminalCount}`)
  },

  setModelEffort(model, effort, machineId) {
    const update = (rec: Record<string, EffortLevel>) => {
      const efforts = { ...rec }
      if (effort) efforts[model] = effort
      else delete efforts[model]
      return efforts
    }
    const m = machineId ? get().machines[machineId] : undefined
    if (m) set((s) => ({ machines: { ...s.machines, [m.id]: { ...m, efforts: update(m.efforts) } } }))
    else set((s) => ({ efforts: update(s.efforts) }))
    void api.setModelEffort(model, effort, machineId)
  },

  async loadTranscript(sessionId, force) {
    if (!sessionId || (get().transcripts[sessionId] && !force)) return
    // Start collecting live events right away, then merge them over the fetched history.
    if (!force) set((s) => ({ transcripts: { ...s.transcripts, [sessionId]: [] } }))
    const items = await api.transcript(sessionId).catch(() => null)
    if (!items) return
    set((s) => {
      // A forced fetch reflects the machine's state after the resync, so it replaces what was cached.
      const live = new Map(force ? [] : (s.transcripts[sessionId] ?? []).map((i) => [i.id, i]))
      const merged = items.map((i) => live.get(i.id) ?? i)
      const known = new Set(items.map((i) => i.id))
      for (const i of live.values()) if (!known.has(i.id)) merged.push(i)
      return { transcripts: { ...s.transcripts, [sessionId]: merged } }
    })
  }
}))

/** Most urgent status wins: approval, then input, then working. */
export function rollup(statuses: NodeStatus[]): NodeStatus {
  if (statuses.includes('approval')) return 'approval'
  if (statuses.includes('input')) return 'input'
  if (statuses.includes('working')) return 'working'
  if (statuses.length && statuses.every((s) => s === 'finished')) return 'finished'
  return 'idle'
}

export function needsUser(s: NodeStatus): boolean {
  return s === 'approval' || s === 'input'
}

type TermListener = { data: (d: string) => void; exit: (code: number) => void }

/** Terminal output skips the store: it arrives many times a second and only its own panel needs it. */
export const terminalBus = {
  listeners: new Map<string, TermListener>(),
  listen(id: string, l: TermListener): () => void {
    this.listeners.set(id, l)
    return () => this.listeners.delete(id)
  },
  deliver(e: Extract<MainEvent, { type: 'term' | 'termExit' }>): void {
    const l = this.listeners.get(e.id)
    if (e.type === 'term') l?.data(e.data)
    else l?.exit(e.code)
  }
}

/** A loop's node status: its active step session's status while running, the signal while it waits for you. */
export function loopStatus(l: LoopInfo, sessions: Record<string, SessionInfo>): NodeStatus {
  switch (l.state) {
    case 'waiting':
    case 'paused':
      return 'input'
    case 'done':
      return 'finished'
    case 'draft':
    case 'stopped':
      return 'idle'
    case 'optimizing': {
      const opt = Object.values(sessions).filter((s) => s.loopId === l.id && s.kind === 'optimize' && !s.handedOff && !s.archived)
      const r = rollup(opt.map((s) => s.status))
      return r === 'approval' || r === 'input' ? r : 'working'
    }
    case 'running': {
      const s = l.activeSessionId ? sessions[l.activeSessionId] : undefined
      return s && (s.status === 'approval' || s.status === 'input') ? s.status : 'working'
    }
  }
}

// ---------- machines ----------

type StoreState = ReturnType<typeof useStore.getState>

export const machineUp = isUp

/** The ~/.claude hub node of a machine. */
export const hubIdFor = (machineId?: string) => (machineId ? withMachine(machineId, USER_HUB_ID) : USER_HUB_ID)

/** Models, default model and efforts of the machine that owns a target (this one when unset). */
export function machineConfig(s: StoreState, machineId?: string): { models: ModelOption[]; defaultModel: string; efforts: Record<string, EffortLevel> } {
  const m = machineId ? s.machines[machineId] : undefined
  return m ? { models: m.models, defaultModel: m.defaultModel, efforts: m.efforts } : { models: s.models, defaultModel: s.defaultModel, efforts: s.efforts }
}

/** Why actions on a machine's things are disabled right now, or null when they are not. */
export function lockReason(s: StoreState, machineId?: string): string | null {
  if (s.control) return `Controlled by ${s.control.by}`
  if (!machineId) return null
  const m = s.machines[machineId]
  return isUp(m) ? null : `${m?.name ?? 'That machine'} is offline`
}

export function useLock(machineId?: string): string | null {
  return useStore((s) => lockReason(s, machineId))
}

export const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

// ---------- Needs you ----------

export interface NeedsItem {
  key: string
  machine: string
  project: string
  summary: string
  since: number
  offline: boolean
  open(): void
}

/** Every waiting approval, question, human loop step and pairing request, on every machine, oldest first. */
export function needsYou(s: StoreState): NeedsItem[] {
  const items: NeedsItem[] = []
  const machineName = (id?: string) => (id ? (s.machines[id]?.name ?? 'Remote machine') : 'This PC')
  const offline = (id?: string) => !!id && !isUp(s.machines[id])
  const projectName = (id: string | null | undefined) => (id ? (s.projects[id]?.name ?? '') : '~/.claude')
  for (const x of Object.values(s.sessions)) {
    if (!waiting(x.status) || x.archived) continue
    items.push({
      key: x.id,
      machine: machineName(x.machineId),
      project: projectName(x.projectId),
      summary: `${x.status === 'approval' ? 'Approval' : 'Question'} · ${x.title.split('\n')[0]}`,
      since: s.waitingSince[x.id] ?? x.createdAt,
      offline: offline(x.machineId),
      open: () => useStore.getState().openPanel('session', x.id)
    })
  }
  for (const l of Object.values(s.loops)) {
    if (l.state !== 'waiting' && l.state !== 'paused') continue
    items.push({
      key: l.id,
      machine: machineName(l.machineId),
      project: projectName(l.projectId),
      summary: `${l.name} · ${l.state === 'waiting' ? `your review at step ${(l.current ?? 0) + 1}` : `paused at step ${(l.current ?? 0) + 1}`}`,
      since: s.waitingSince[l.id] ?? l.createdAt,
      offline: offline(l.machineId),
      open: () => useStore.getState().openPanel('loop', l.id)
    })
  }
  for (const m of Object.values(s.machines)) {
    if (m.status !== 'pairing') continue
    items.push({ key: m.id, machine: m.name, project: '', summary: 'Wants to pair · compare the code', since: m.since, offline: false, open: () => useStore.getState().openPanel('pairing', m.id) })
  }
  return items.sort((a, b) => a.since - b.since)
}
