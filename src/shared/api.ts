// The bridge the renderer talks to (exposed as window.symphony by the preload script).
import type {
  AppSnapshot,
  ApprovalDecision,
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
  TranscriptItem
} from './types'

export interface InvokeApi {
  snapshot(): Promise<AppSnapshot>
  /** Without a path, shows the folder picker. */
  addProject(path?: string): Promise<Project | null>
  removeProject(id: string): Promise<void>
  moveNode(id: string, position: Point): Promise<void>
  startPipeline(projectId: string, prompt: string, model: string, effort?: EffortLevel, images?: ImageInput[]): Promise<void>
  startConfigSession(targetId: string, prompt: string, model: string, effort?: EffortLevel, images?: ImageInput[]): Promise<void>
  sendMessage(sessionId: string, text: string, images?: ImageInput[]): Promise<void>
  stopSession(sessionId: string): Promise<void>
  dismissSession(sessionId: string): Promise<void>
  transcript(sessionId: string): Promise<TranscriptItem[]>
  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision, message?: string): Promise<void>
  respondQuestion(sessionId: string, requestId: string, answers: Record<string, string>): Promise<void>
  gitStats(projectId: string): Promise<GitStats>
  gitFileDiff(projectId: string, file: GitFileStat): Promise<GitFileDiff>
  readSkill(skillId: string): Promise<{ path: string; content: string }>
  readClaudeMd(projectId: string): Promise<{ path: string; content: string; exists: boolean }>
  writeClaudeMd(projectId: string, content: string): Promise<string>
  refreshConfig(): Promise<void>
  ghLogin(): Promise<void>
  setDefaultModel(model: string): Promise<void>
  /** Remember the effort for a model; null forgets it (back to the model's default). */
  setModelEffort(model: string, effort: EffortLevel | null): Promise<void>
  refreshUsage(): Promise<void>
  /** Start a terminal in a project's folder, or the home folder when projectId is null. */
  /** Returns the shell's display name, e.g. "PowerShell". */
  termStart(id: string, projectId: string | null, cols: number, rows: number): Promise<string>
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
  setAutoApprove(on: boolean): Promise<void>
  /** Ask the OS for microphone access where needed (macOS). */
  micAccess(): Promise<boolean>
  /** Clean up dictated text with Claude Haiku (filler words, punctuation, misheard terms). */
  refineDictation(text: string): Promise<string>
  /** Language to transcribe in (Claude Code's `language` setting, else English). */
  dictationLanguage(): Promise<string>
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
  'dictationLanguage'
]

export interface SymphonyBridge extends InvokeApi {
  onEvent(cb: (e: MainEvent) => void): () => void
  /** Absolute path of a file/folder dropped onto the window. */
  pathForFile(file: File): string
  platform: string
}
