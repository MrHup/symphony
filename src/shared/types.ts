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
}

/** task: a normal session. optimize: the /optimize-prompt step of the pipeline. config: edits a skill or MCP server. */
export type SessionKind = 'task' | 'optimize' | 'config'

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
      result?: { text: string; isError: boolean }
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
      resolved?: 'allow' | 'always' | 'deny'
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

export interface SkillInfo {
  id: string
  name: string
  description: string
  path: string
  scope: 'user' | 'project' | 'plugin' | 'synced'
  /** Set for project-scope skills. */
  projectId?: string
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
  added: number
  removed: number
  files: GitFileStat[]
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
  usage: UsageInfo | null
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
  | { type: 'config'; skills: SkillInfo[]; mcp: McpInfo[] }
  | { type: 'gh'; gh: GhAccounts }
  | { type: 'login'; prompt: LoginPrompt }
  | { type: 'models'; models: ModelOption[] }
  | { type: 'focus'; sessionId: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'term'; id: string; data: string }
  | { type: 'termExit'; id: string; code: number }

export const USER_HUB_ID = 'hub:user'
