// Tools: modules in src/tools/<id>/ that bring their own logic, skills, agent tools and panel. A tool
// has two parts. Its core runs on the machine the user picked (this one, or a remote machine, reached
// through the same `toolCall` request over the link) and keeps the tool's state there. Its local part,
// if any, runs where the user is (the machine with the window) and serves things that only make sense
// there, such as a preview server for a phone on the same network.
import type { EffortLevel, GhIdentity, MainEvent, Project } from '@shared/types'
import type { SessionManager } from './sessions'

/** What a tool's core may use of the core it runs in. */
export interface ToolDeps {
  sessions: SessionManager
  /** The tool's state changed: it is sent to every window that shows this machine. */
  changed(): void
  /** Every event of this core (sessions, projects, ...). */
  on(listener: (e: MainEvent) => void): () => void
  /** Adds a folder as a project on this machine (or returns the one already there). */
  addProject(path: string): Promise<Project | null>
  removeProject(id: string): Promise<void>
  projects(): Project[]
  identityFor(cwd: string): Promise<{ identity: GhIdentity; env: Record<string, string> }>
  /** The effort, if the model accepts it. */
  effortFor(model: string, effort?: EffortLevel): EffortLevel | undefined
}

/**
 * The part of a tool that runs on the machine it is used on. Methods whose name starts with `get` only
 * read, so a remote machine's audit log leaves them out.
 */
export interface ToolCore {
  /** Called once the data folder is known. */
  start(): void
  /** What the tool's panel shows; sent with the snapshot and in `tool` events. */
  state(): unknown
  call(method: string, args: unknown[]): Promise<unknown>
  shutdown(): void
}

/** The part of a tool that runs on the machine with the window; `invoke` reaches every machine. */
export interface ToolLocal {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Every event the window gets, remote machines' included. */
  onEvent(e: MainEvent): void
  shutdown(): void
}

export interface ToolModule {
  id: string
  core(deps: ToolDeps): ToolCore
  local?(invoke: (method: string, args: unknown[]) => Promise<unknown>): ToolLocal
}

export const TOOLS: ToolModule[] = []

/** The cores of every tool, in one Symphony core. */
export class ToolManager {
  private cores = new Map<string, ToolCore>()

  constructor(deps: Omit<ToolDeps, 'changed'> & { emit(e: MainEvent): void }) {
    for (const t of TOOLS) {
      const changed = () => deps.emit({ type: 'tool', tool: t.id, state: this.cores.get(t.id)?.state() })
      this.cores.set(t.id, t.core({ ...deps, changed }))
    }
  }

  start(): void {
    for (const c of this.cores.values()) c.start()
  }

  state(): Record<string, unknown> {
    return Object.fromEntries([...this.cores].map(([id, c]) => [id, c.state()]))
  }

  call(tool: string, method: string, args: unknown[]): Promise<unknown> {
    const c = this.cores.get(tool)
    if (!c) return Promise.reject(new Error(`Unknown tool: ${tool}`))
    return c.call(method, args)
  }

  shutdown(): void {
    for (const c of this.cores.values()) c.shutdown()
  }
}

/** The local parts of every tool, on the machine with the window. */
export class LocalTools {
  private locals = new Map<string, ToolLocal>()

  constructor(invoke: (method: string, args: unknown[]) => Promise<unknown>) {
    for (const t of TOOLS) if (t.local) this.locals.set(t.id, t.local(invoke))
  }

  call(tool: string, method: string, args: unknown[]): Promise<unknown> {
    const l = this.locals.get(tool)
    if (!l) return Promise.reject(new Error(`Unknown tool: ${tool}`))
    return l.call(method, args)
  }

  onEvent(e: MainEvent): void {
    for (const l of this.locals.values()) l.onEvent(e)
  }

  shutdown(): void {
    for (const l of this.locals.values()) l.shutdown()
  }
}
