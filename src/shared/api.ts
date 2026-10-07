// The bridge the renderer talks to (exposed as window.symphony by the preload script).
import type {
  AppSnapshot,
  ApprovalDecision,
  AuditEntry,
  FolderListing,
  GitFileDiff,
  GitFileStat,
  GitStats,
  MainEvent,
  Point,
  Project,
  EffortLevel,
  ImageInput,
  LoopArtifact,
  LoopDecision,
  LoopDraft,
  LoopInfo,
  RemoteStatus,
  TranscriptItem
} from './types'

/**
 * Requests that name a project, session, loop, skill or terminal go to the machine that owns it.
 * Those that name nothing a machine owns take an optional trailing machineId (missing means this
 * machine); see MACHINE_ARG in remote.ts.
 */
export interface InvokeApi {
  snapshot(): Promise<AppSnapshot>
  /** Without a path, shows the folder picker. A remote machine needs a path (from its folder browser). */
  addProject(path?: string, machineId?: string): Promise<Project | null>
  removeProject(id: string): Promise<void>
  moveNode(id: string, position: Point): Promise<void>
  startPipeline(projectId: string, prompt: string, model: string, effort?: EffortLevel, images?: ImageInput[]): Promise<void>
  startConfigSession(targetId: string, prompt: string, model: string, effort?: EffortLevel, images?: ImageInput[]): Promise<void>
  sendMessage(sessionId: string, text: string, images?: ImageInput[]): Promise<void>
  stopSession(sessionId: string): Promise<void>
  dismissSession(sessionId: string): Promise<void>
  transcript(sessionId: string): Promise<TranscriptItem[]>
  /** Null when applied; otherwise why not (it was already answered elsewhere). */
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision, message?: string): Promise<string | null>
  respondQuestion(sessionId: string, requestId: string, answers: Record<string, string>): Promise<string | null>
  gitStats(projectId: string): Promise<GitStats>
  gitFileDiff(projectId: string, file: GitFileStat): Promise<GitFileDiff>
  readSkill(skillId: string): Promise<{ path: string; content: string }>
  readClaudeMd(projectId: string): Promise<{ path: string; content: string; exists: boolean }>
  writeClaudeMd(projectId: string, content: string): Promise<string>
  /** Every connected machine without a machineId ('local' for this one only). */
  refreshConfig(machineId?: string): Promise<void>
  ghLogin(machineId?: string): Promise<void>
  setDefaultModel(model: string, machineId?: string): Promise<void>
  /** Remember the effort for a model; null forgets it (back to the model's default). */
  setModelEffort(model: string, effort: EffortLevel | null, machineId?: string): Promise<void>
  refreshUsage(): Promise<void>
  /** Start a terminal in a project's folder, or the machine's home folder when projectId is null. */
  /** Returns the shell's display name, e.g. "PowerShell". */
  termStart(id: string, projectId: string | null, cols: number, rows: number, machineId?: string): Promise<string>
  termWrite(id: string, data: string): Promise<void>
  termResize(id: string, cols: number, rows: number): Promise<void>
  termKill(id: string): Promise<void>
  loopCreate(projectId: string, draft: LoopDraft): Promise<LoopInfo>
  /** Only while the loop is not running. */
  loopUpdate(id: string, draft: LoopDraft): Promise<LoopInfo>
  loopDelete(id: string): Promise<void>
  /** Starts a draft/stopped/done loop from step 1, or resumes a paused one at its current step. */
  loopStart(id: string): Promise<void>
  loopStop(id: string): Promise<void>
  loopDecide(id: string, decision: LoopDecision): Promise<void>
  /** Opens a handed-over file in its default app, or a URL in the browser. */
  openArtifact(projectId: string, artifact: LoopArtifact): Promise<string | null>
  /** Allow Claude Code permission prompts without asking (not questions, not prompts forced by your own ask rules). */
  setAutoApprove(on: boolean, machineId?: string): Promise<void>
  /** Ask the OS for microphone access where needed (macOS). */
  micAccess(): Promise<boolean>
  /** Clean up dictated text with Claude Haiku (filler words, punctuation, misheard terms). */
  refineDictation(text: string): Promise<string>
  /** Language to transcribe in (Claude Code's `language` setting, else English). */
  dictationLanguage(): Promise<string>
  /** A terminal running the bundled Claude Code binary with /login. */
  claudeLogin(id: string, cols: number, rows: number): Promise<string>

  // ---------- remote orchestration (never routed) ----------
  remoteStatus(): Promise<RemoteStatus>
  /** This machine as orchestrator: listen for remote machines on the local network. */
  remoteSetOrchestrate(on: boolean): Promise<void>
  /** This machine as remote: let a paired orchestrator control it. */
  remoteSetRemoteMode(on: boolean): Promise<void>
  /** Remote side: ask the orchestrator at host[:port] to pair. */
  remotePair(address: string): Promise<void>
  /** Accept or reject a pairing code: a machine id on the orchestrator, 'orchestrator' on the remote side. */
  remotePairDecision(id: string, accept: boolean): Promise<void>
  /** Forget a paired machine (or, on the remote side, 'orchestrator'). */
  remoteRevoke(id: string): Promise<void>
  /** Remote side: end the link now; the window becomes editable. */
  remoteDisconnect(): Promise<void>
  remoteSettings(patch: { graceSeconds?: number; sharedFolders?: string[]; terminals?: boolean; port?: number }): Promise<void>
  /** Native folder picker for a shared folder. */
  remotePickFolder(): Promise<string | null>
  remoteAudit(): Promise<AuditEntry[]>
  /** Folders a remote machine shares (no path) or the subfolders of one. */
  remoteBrowse(machineId: string, path?: string): Promise<FolderListing>
}

export const INVOKE_METHODS: (keyof InvokeApi)[] = [
  'snapshot',
  'addProject',
  'removeProject',
  'moveNode',
  'startPipeline',
  'startConfigSession',
  'sendMessage',
  'stopSession',
  'dismissSession',
  'transcript',
  'respondApproval',
  'respondQuestion',
  'gitStats',
  'gitFileDiff',
  'readSkill',
  'readClaudeMd',
  'writeClaudeMd',
  'refreshConfig',
  'ghLogin',
  'setDefaultModel',
  'setModelEffort',
  'refreshUsage',
  'termStart',
  'termWrite',
  'termResize',
  'termKill',
  'loopCreate',
  'loopUpdate',
  'loopDelete',
  'loopStart',
  'loopStop',
  'loopDecide',
  'openArtifact',
  'setAutoApprove',
  'micAccess',
  'refineDictation',
  'dictationLanguage',
  'claudeLogin',
  'remoteStatus',
  'remoteSetOrchestrate',
  'remoteSetRemoteMode',
  'remotePair',
  'remotePairDecision',
  'remoteRevoke',
  'remoteDisconnect',
  'remoteSettings',
  'remotePickFolder',
  'remoteAudit',
  'remoteBrowse'
]

export interface SymphonyBridge extends InvokeApi {
  onEvent(cb: (e: MainEvent) => void): () => void
  /** Absolute path of a file/folder dropped onto the window. */
  pathForFile(file: File): string
  platform: string
}
