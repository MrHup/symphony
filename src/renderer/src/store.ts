import { create } from 'zustand'
import type {
  AgentInfo,
  AppSnapshot,
  EffortLevel,
  GhAccounts,
  GitStats,
  LoginPrompt,
  MainEvent,
  McpInfo,
  ModelOption,
  NodeStatus,
  Point,
  Project,
  SessionInfo,
  SkillInfo,
  TranscriptItem,
  UsageInfo
} from '@shared/types'

export const api = window.symphony

export type PanelKind = 'session' | 'agent' | 'diff' | 'skill' | 'mcp' | 'claudemd' | 'login' | 'terminal' | 'usage'

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
  hubOpen: boolean
  gh: GhAccounts
  models: ModelOption[]
  defaultModel: string
  efforts: Record<string, EffortLevel>
  usage: UsageInfo | null
  transcripts: Record<string, TranscriptItem[]>
  login: LoginPrompt | null
  panels: Panel[]
  composer: Composer | null
  apply(e: MainEvent): void
  load(s: AppSnapshot): void
  openPanel(kind: PanelKind, targetId: string): void
  closePanel(id: string): void
  raisePanel(id: string): void
  updatePanel(id: string, patch: Partial<Panel>): void
  setComposer(c: Composer | null): void
  setHubOpen(open: boolean): void
  setDefaultModel(model: string): void
  setModelEffort(model: string, effort: EffortLevel | null): void
  /** Open a new terminal in a project's folder, or the home folder when projectId is null. */
  openTerminal(projectId: string | null): void
  loadTranscript(sessionId: string): Promise<void>
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
  usage: { w: 400, h: 300 }
}

let terminalCount = 0

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: {},
  sessions: {},
  agents: {},
  skills: [],
  mcp: [],
  git: {},
  hubPosition: { x: -420, y: 0 },
  hubOpen: true,
  gh: { installed: false, hosts: {} },
  models: [],
  defaultModel: 'opus',
  efforts: {},
  usage: null,
  transcripts: {},
  login: null,
  panels: [],
  composer: null,

  load(s) {
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
      usage: s.usage
    })
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
        set((s) => ({ sessions: { ...s.sessions, [e.session.id]: { ...s.sessions[e.session.id], ...e.session } } }))
        break
      case 'sessionRemoved':
        set((s) => ({
          sessions: omit(s.sessions, e.id),
          transcripts: omit(s.transcripts, e.id),
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
        set({ skills: e.skills, mcp: e.mcp })
        break
      case 'gh':
        set({ gh: e.gh })
        break
      case 'login':
        set({ login: e.prompt })
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
      case 'term':
      case 'termExit':
        terminalBus.deliver(e)
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

  setHubOpen(open) {
    set({ hubOpen: open })
  },

  setDefaultModel(model) {
    set({ defaultModel: model })
    void api.setDefaultModel(model)
  },

  openTerminal(projectId) {
    // Each terminal gets its own panel, so a project can have several.
    get().openPanel('terminal', `${projectId ?? 'home'}#${++terminalCount}`)
  },

  setModelEffort(model, effort) {
    set((s) => {
      const efforts = { ...s.efforts }
      if (effort) efforts[model] = effort
      else delete efforts[model]
      return { efforts }
    })
    void api.setModelEffort(model, effort)
  },

  async loadTranscript(sessionId) {
    if (!sessionId || get().transcripts[sessionId]) return
    // Start collecting live events right away, then merge them over the fetched history.
    set((s) => ({ transcripts: { ...s.transcripts, [sessionId]: [] } }))
    const items = await api.transcript(sessionId)
    set((s) => {
      const live = new Map((s.transcripts[sessionId] ?? []).map((i) => [i.id, i]))
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
