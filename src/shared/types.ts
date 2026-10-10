// Types shared by the main process, preload bridge and renderer.

/** The five looks a node can have. `idle` is a node with nothing going on. */
export type NodeStatus = 'idle' | 'working' | 'input' | 'approval' | 'finished'

export interface Point {
  x: number
  y: number
}

export interface Project {
  id: string
  path: string
  name: string
  position: Point
  /** The remote machine that owns it; unset means this machine. */
  machineId?: string
}

/** The colors a machine can pick for its nodes' glyphs (`.accent-*` in styles.css). */
export const MACHINE_COLORS = ['blue', 'teal', 'green', 'violet', 'pink', 'sand'] as const
export type MachineColor = (typeof MACHINE_COLORS)[number]

/** A sticky note on this machine's board. */
export interface Note {
  id: string
  /** Markdown. */
  text: string
  position: Point
}

/** task: a normal session. optimize: the /optimize-prompt step of the pipeline. config: edits a skill or MCP server. loop: one run of a loop step. */
export type SessionKind = 'task' | 'optimize' | 'config' | 'loop'

export interface GhIdentity {
  host: string
  /** null when gh has no account for this host. */
  login: string | null
}

export interface SessionInfo {
  id: string
  kind: SessionKind
  /** Node this session hangs off: a project id, the user hub id, or a skill/MCP node id. */
  anchorId: string
  projectId: string | null
  cwd: string
  title: string
  model: string
  /** Unset means the model's own default effort. */
  effort?: EffortLevel
  status: NodeStatus
  createdAt: number
  sdkSessionId?: string
  identity?: GhIdentity
  position?: Point
  /** Set on an optimize session once the pipeline has started the real session; its node then fades out. */
  handedOff?: boolean
  /** Loop sessions: the loop and the step index they ran. */
  loopId?: string
  loopStep?: number
  /** Hidden from the graph (an earlier run of a loop step); still listed in the loop's history. */
  archived?: boolean
  machineId?: string
}

export interface AgentInfo {
  /** The SDK task_id. */
  id: string
  sessionId: string
  /** tool_use_id of the Agent/Task call that spawned it; transcript items carry it as `parent`. */
  toolUseId?: string
  description: string
  subagentType?: string
  status: NodeStatus
}

export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** An image pasted into a prompt. */
export interface ImageInput {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** Base64 without the data: prefix; what Claude receives. */
  data: string
  /** Small data-URL preview kept in the transcript. */
  thumb: string
}

/** A file the user added to a project's .claude-references folder, for prompts to point at. */
export interface ReferenceFile {
  name: string
  /** Relative to the project folder, with forward slashes; what a prompt mentions as `@<path>`. */
  path: string
  size: number
  modified: number
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; images?: string[] }
  | { kind: 'thinking'; id: string; text: string; parent: string | null; live?: boolean }
  | { kind: 'text'; id: string; text: string; parent: string | null; live?: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      input: Record<string, unknown>
      parent: string | null
      /** files: images the tool returned (e.g. Read on a screenshot), kept so they can be seen. */
      result?: { text: string; isError: boolean; files?: AssetRef[] }
    }
  | {
      kind: 'approval'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      description?: string
      parent: string | null
      agentId?: string
      canAlwaysAllow: boolean
      /** auto: allowed by auto-approve, without asking. */
      resolved?: 'allow' | 'always' | 'deny' | 'auto'
    }
  | {
      kind: 'question'
      id: string
      questions: AskQuestion[]
      parent: string | null
      agentId?: string
      resolved?: Record<string, string>
    }
  | { kind: 'result'; id: string; text: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'notice'; id: string; text: string }
  /** Files Claude showed with the show_files tool. */
  | { kind: 'files'; id: string; files: AssetRef[]; note?: string }

/**
 * A file copied into the asset store of the machine that made it, at the moment it was shown or
 * handed over, so what you review cannot change afterwards. The id is the SHA-256 of its content.
 */
export interface AssetRef {
  id: string
  name: string
  mediaType: string
  size: number
  /** Where the file was, on the machine that made it. */
  path: string
  /** A small preview as a data URL; missing when none could be made. */
  thumb?: string
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  path: string
  scope: 'user' | 'project' | 'plugin' | 'synced'
  /** Set for project-scope skills. */
  projectId?: string
  machineId?: string
}

export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

export interface McpInfo {
  id: string
  name: string
  status: McpStatus
  scope?: string
  source?: string
  error?: string
  tools: string[]
  /** Config with secret values replaced. */
  config?: unknown
  projectId?: string
  machineId?: string
}

export interface GitFileStat {
  path: string
  /** Set for renames. */
  oldPath?: string
  /** M modified, A added, D deleted, R renamed, U untracked */
  status: 'M' | 'A' | 'D' | 'R' | 'U'
  added: number
  removed: number
  binary: boolean
}

export interface GitStats {
  isRepo: boolean
  /** The checked-out branch, or the short commit hash when HEAD is detached. */
  branch?: string
  /** Lines changed vs HEAD, staged or not. */
  added: number
  removed: number
  /** The index vs HEAD. */
  staged: GitFileStat[]
  /** The working tree vs the index, untracked files included. */
  unstaged: GitFileStat[]
}

export interface GitFileDiff {
  path: string
  original: string
  modified: string
  binary: boolean
}

/** Claude Code effort levels, lowest to highest. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra-high',
  max: 'Max'
}

export interface ModelOption {
  value: string
  label: string
  /** Effort levels this model accepts; empty when it has no effort setting. */
  efforts: EffortLevel[]
}

export interface GhAccounts {
  installed: boolean
  hosts: Record<string, { login: string; active: boolean; state: string }[]>
}

export interface LoginPrompt {
  code: string | null
  url: string | null
  done: boolean
  error?: string
}

// ---------- loops ----------

export type LoopStepKind = 'agent' | 'human'

export interface LoopStep {
  id: string
  kind: LoopStepKind
  title: string
  /** Agent: the task. Human: what to review and how to decide. */
  prompt: string
  model?: string
  effort?: EffortLevel
  /** Agent steps: sent with every run of the step (e.g. design references). */
  images?: ImageInput[]
  /** The prompt after /optimize-prompt, reused until the step is edited. */
  optimized?: string
  /** What `optimized` was made from, to tell when the step changed. */
  optimizedFrom?: string
}

export interface LoopArtifact {
  label: string
  /** A file, absolute or relative to the project folder. */
  path?: string
  url?: string
  /** The file as copied at handoff (images, PDFs and other viewable files). */
  asset?: AssetRef
}

/** One move of the loop: who decided, from which step, to where, and what they handed over. */
export interface LoopHandoff {
  fromStep: number
  /** forward: next step (or finish after the last). back: to `toStep`. stop: the user stopped the loop. */
  decision: 'forward' | 'back' | 'stop'
  /** Step the loop moved to; null when it finished or stopped. */
  toStep: number | null
  by: 'agent' | 'human'
  summary: string
  artifacts: LoopArtifact[]
  sessionId?: string
  at: number
}

/**
 * draft: defined, never started. optimizing: improving step prompts. running: an agent step runs.
 * waiting: a human step waits for you. paused: needs you to route it (no routing, stopped step, run limit).
 * done: the last step moved forward. stopped: you stopped it.
 */
export type LoopState = 'draft' | 'optimizing' | 'running' | 'waiting' | 'paused' | 'done' | 'stopped'

export interface LoopInfo {
  id: string
  projectId: string
  name: string
  steps: LoopStep[]
  /** Most agent step runs in a row without a human decision, so a loop cannot cycle forever unattended. */
  maxRuns: number
  state: LoopState
  /** Index of the step that is running or waiting. */
  current: number | null
  /** Agent step runs so far. */
  runs: number
  /** `runs` at the last human decision; the run limit counts from here. */
  runsAtHuman?: number
  history: LoopHandoff[]
  /** false: agent steps run with their own prompts. Unset (loops saved before the option) means on. */
  optimize?: boolean
  activeSessionId?: string
  pausedReason?: string
  createdAt: number
  position?: Point
  machineId?: string
}

/** What the loop editor sends: the definition without run state. */
export interface LoopDraft {
  name: string
  steps: LoopStep[]
  maxRuns: number
  /** Improve agent prompts with /optimize-prompt when the loop starts. */
  optimize: boolean
}

/** A routing decision made by you, on a human step or a paused loop. */
export interface LoopDecision {
  decision: 'forward' | 'back' | 'stop'
  /** With back: the step index to return to. */
  step?: number
  feedback: string
}

export interface UsageWindow {
  id: string
  label: string
  /** 0–100 */
  percent: number
  /** ISO timestamp, or null when the window has not started. */
  resetsAt: string | null
}

export interface UsageInfo {
  /** False for API-key and cloud-provider logins, where plan limits do not apply. */
  available: boolean
  /** claude.ai plan, e.g. "max" or "pro". */
  plan: string | null
  windows: UsageWindow[]
  fetchedAt: number
  error?: string
}

export interface AppSnapshot {
  projects: Project[]
  sessions: SessionInfo[]
  agents: AgentInfo[]
  skills: SkillInfo[]
  mcp: McpInfo[]
  git: Record<string, GitStats>
  hubPosition: Point
  gh: GhAccounts
  models: ModelOption[]
  defaultModel: string
  /** The effort last picked for each model. */
  efforts: Record<string, EffortLevel>
  /** The composer's last "Optimize prompt" choice. */
  optimizePrompts: boolean
  /** Glyph color of each machine's nodes, by machine id ('local' for this one). Kept on this machine. */
  machineColors: Record<string, MachineColor>
  usage: UsageInfo | null
  loops: LoopInfo[]
  autoApprove: boolean
  /** Remote machines this orchestrator knows (paired or asking to pair). Empty elsewhere. */
  machines: MachineState[]
  /** Position of this machine's own node, shown once remote machines exist. */
  machinePosition: Point
  /** Set while another Symphony controls this one: the window is read-only. */
  control: ControlState | null
  notes: Note[]
}

// ---------- remote machines ----------

/**
 * online: linked and in sync. reconnecting: linked, resyncing. offline: the link went silent.
 * asleep / quit: the machine said so before it went. pairing: asks to pair, waiting for you.
 */
export type MachineStatus = 'online' | 'reconnecting' | 'offline' | 'asleep' | 'quit' | 'pairing'

export interface MachineHealth {
  /** Battery percentage, or null when unknown or there is no battery. */
  battery: number | null
  charging: boolean
  lowPower: boolean
}

/** A remote machine as the orchestrator shows it. Its id is its certificate fingerprint. */
export interface MachineState {
  id: string
  name: string
  platform: string
  appVersion: string
  status: MachineStatus
  /** When the current status began. */
  since: number
  /** Runs a different Symphony version (or protocol) than this one. */
  outdated?: boolean
  health?: MachineHealth
  position: Point
  hubPosition: Point
  gh: GhAccounts
  models: ModelOption[]
  defaultModel: string
  efforts: Record<string, EffortLevel>
  autoApprove: boolean
  /** The machine allows remote terminals. */
  terminals: boolean
  /** While pairing: the 6-digit code to compare. */
  pairCode?: string
}

/** On a remote machine: who controls it. grace: the link dropped, read-only until graceEndsAt. */
export interface ControlState {
  by: string
  mode: 'connected' | 'grace'
  graceEndsAt?: number
}

export type LinkState = 'off' | 'unpaired' | 'pairing' | 'connecting' | 'connected' | 'grace' | 'retrying'

export interface DiscoveredOrchestrator {
  id: string
  name: string
  host: string
  port: number
}

/** Everything the remote-orchestration panel shows, for both roles. */
export interface RemoteStatus {
  machineName: string
  /** This machine's certificate fingerprint; null until remote orchestration is first used. */
  machineId: string | null
  orchestrator: {
    enabled: boolean
    port: number
    addresses: string[]
    error?: string
    machines: { id: string; name: string; platform: string; status: MachineStatus; lastSeen: number }[]
    pairing: { id: string; name: string; code: string; accepted: boolean }[]
  }
  remote: {
    enabled: boolean
    state: LinkState
    pc: DiscoveredOrchestrator | null
    discovered: DiscoveredOrchestrator[]
    pairing: { name: string; code: string; accepted: boolean; peerAccepted: boolean } | null
    error?: string
    graceSeconds: number
    sharedFolders: string[]
    terminals: boolean
  }
}

export interface AuditEntry {
  at: number
  action: string
  detail?: string
}

export interface FolderListing {
  /** Null for the list of shared folders itself. */
  path: string | null
  parent: string | null
  entries: { name: string; path: string; git: boolean }[]
}

export type ApprovalDecision = 'allow' | 'always' | 'deny'

/** Events pushed from main to the renderer. */
export type MainEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'project'; project: Project }
  | { type: 'projectRemoved'; id: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'sessionRemoved'; id: string }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'agentRemoved'; id: string }
  | { type: 'transcript'; sessionId: string; item: TranscriptItem }
  | { type: 'git'; projectId: string; stats: GitStats }
  /** Replaces the skills and MCP servers of one machine (this one when machineId is unset). */
  | { type: 'config'; skills: SkillInfo[]; mcp: McpInfo[]; machineId?: string }
  | { type: 'gh'; gh: GhAccounts }
  | { type: 'login'; prompt: LoginPrompt; machineId?: string }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'focus'; sessionId: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'loop'; loop: LoopInfo }
  | { type: 'loopRemoved'; id: string }
  | { type: 'autoApprove'; on: boolean }
  | { type: 'term'; id: string; data: string }
  | { type: 'termExit'; id: string; code: number }
  | { type: 'machine'; machine: MachineState }
  | { type: 'machineRemoved'; id: string }
  | { type: 'control'; control: ControlState | null }
  | { type: 'remote'; status: RemoteStatus }
  | { type: 'note'; note: Note }
  | { type: 'noteRemoved'; id: string }

export const USER_HUB_ID = 'hub:user'

/** The tool every session has for showing files to the user (see sessions.ts). */
export const SHOW_FILES_SERVER = 'symphony_view'
export const SHOW_FILES_TOOL = `mcp__${SHOW_FILES_SERVER}__show_files`
