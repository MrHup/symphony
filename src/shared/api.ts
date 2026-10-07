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
  'termKill'
]

export interface SymphonyBridge extends InvokeApi {
  onEvent(cb: (e: MainEvent) => void): () => void
  /** Absolute path of a file/folder dropped onto the window. */
  pathForFile(file: File): string
  platform: string
}
