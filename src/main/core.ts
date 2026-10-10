// Symphony's core: the services (sessions, loops, git, config discovery, terminals) and every
// request the window can make, without the window itself. The local window talks to it over IPC;
// in remote mode an orchestrator on another machine talks to it over the link. Events go to any
// number of listeners. Electron features arrive as adapters (platform.ts), so this file is plain Node.
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InvokeApi } from '@shared/api'
import { READ_METHODS } from '@shared/remote'
import { USER_HUB_ID, type AppSnapshot, type ControlState, type EffortLevel, type ImageInput, type UsageInfo, type GhAccounts, type GitStats, type McpInfo, type MainEvent, type ModelOption, type Note, type Point, type Project, type SkillInfo } from '@shared/types'
import { dictationLanguage, inspect, isProjectScoped, projectSkills, readClaudeMd, readUsage, toMcpInfo, userSkills, writeClaudeMd } from './claudeConfig'
import { TerminalManager } from './terminals'
import { LoopManager } from './loops'
import { commitStaged, getFileDiff, getStats, listBranches, remoteHost, stage, switchBranch, unstage } from './git'
import { getAccounts, login, resolveIdentity } from './github'
import { extractOptimizedPrompt, OPTIMIZE_LINGER_MS, optimizeCommand } from './pipeline'
import { refineDictation } from './dictation'
import { claudeExecutable, claudeJsonPath, home, samePath, type Adapters } from './platform'
import { AssetStore, assetIdsOfLoop } from './assets'
import { SessionManager } from './sessions'
import { dataPath, loadState, saveState, type PersistedState } from './store'

const GIT_POLL_MS = 4000
const CONFIG_POLL_MS = 3 * 60_000
const USAGE_POLL_MS = 2 * 60_000
const RELEASE_DELAY_MS = 2000
const STARTUP_SWEEP_DELAY_MS = 60_000
const STARTUP_SWEEP_MIN_AGE_MS = 10 * 60_000

/** The requests the core serves: the window's API without remote orchestration (handled around it). */
export type CoreApi = Omit<InvokeApi, `remote${string}`>
export type CoreMethod = keyof CoreApi

export class SymphonyCore {
  state!: PersistedState
  readonly sessions: SessionManager
  readonly terminals: TerminalManager
  readonly loops: LoopManager
  /** Files shown in sessions and handed over between loop steps (and, on an orchestrator, fetched from remote machines). */
  readonly assets: AssetStore
  readonly handlers: CoreApi
  /** Set while another Symphony controls this machine; the local window is then read-only. */
  control: ControlState | null = null

  private listeners = new Set<(e: MainEvent) => void>()
  private gh: GhAccounts = { installed: false, hosts: {} }
  private models: ModelOption[] = []
  private hubSkills: SkillInfo[] = []
  private hubMcp: McpInfo[] = []
  private projectConfig = new Map<string, { skills: SkillInfo[]; mcp: McpInfo[] }>()
  private gitStats = new Map<string, GitStats>()
  private usage: UsageInfo | null = null
  private autoApprove = false
  private usagePolling = true
  private usageAfterTurn: NodeJS.Timeout | undefined
  private usageInFlight: Promise<void> | null = null
  private gitLoopRunning = false
  private timers: NodeJS.Timeout[] = []
  private released = new Set<string>()
  private releaseTimer: NodeJS.Timeout | undefined
  /** Stored files something outside the core needs (an orchestrator's copies of remote files). */
  extraFileRefs: () => Iterable<string> = () => []

  constructor(private adapters: Adapters) {
    this.assets = new AssetStore(() => dataPath('assets'), adapters.thumbnail)
    this.sessions = new SessionManager((e) => this.emit(e), () => this.persist(), this.assets)
    this.sessions.onFilesReleased = (ids) => this.releaseFiles(ids)
    this.terminals = new TerminalManager((e) => this.emit(e))
    this.loops = new LoopManager({
      sessions: this.sessions,
      emit: (e) => this.emit(e),
      persist: () => this.persist(),
      project: (id) => this.project(id),
      identityFor: (cwd) => this.identityFor(cwd),
      defaultModel: () => this.state.defaultModel,
      assets: this.assets,
      releaseFiles: (ids) => this.releaseFiles(ids)
    })
    this.handlers = this.createHandlers()
  }

  /** Load the saved graph, restore sessions and loops, and start the background refreshes. */
  start(): void {
    this.state = loadState()
    this.sessions.restore(this.state.sessions)
    this.loops.restore(this.state.loops)
    void this.refreshGh()
    void this.gitLoop()
    void this.refreshAllConfig()
    void this.refreshUsage()
    this.timers.push(
      // A late sweep catches files left behind (say, by a crash between deleting a session and its files).
      setTimeout(() => this.sweepFiles(this.assets.ids(), STARTUP_SWEEP_MIN_AGE_MS), STARTUP_SWEEP_DELAY_MS),
      setInterval(() => void this.gitLoop(), GIT_POLL_MS),
      setInterval(() => this.usagePolling && void this.refreshUsage(), USAGE_POLL_MS),
      setInterval(() => void this.refreshAllConfig(), CONFIG_POLL_MS)
    )
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t)
    clearTimeout(this.releaseTimer)
    this.persist()
    this.sessions.closeAll()
    this.terminals.killAll()
  }

  on(listener: (e: MainEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A request from a trusted caller: an orchestrator over the link, or the window after the read-only check. */
  invoke(method: string, args: unknown[]): Promise<unknown> {
    const fn = (this.handlers as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method]
    if (!fn) return Promise.reject(new Error(`Unknown request: ${method}`))
    return Promise.resolve().then(() => fn(...args))
  }

  /** A request from this machine's own window: while controlled, only reading is allowed. */
  invokeLocal(method: string, args: unknown[]): Promise<unknown> {
    if (this.control && !READ_METHODS.has(method)) return Promise.reject(new Error(`Controlled by ${this.control.by}`))
    return this.invoke(method, args)
  }

  setControl(control: ControlState | null): void {
    this.control = control
    this.emit({ type: 'control', control })
  }

  /** Remote machines stop polling usage while linked: only the orchestrator's own usage is shown. */
  setUsagePolling(on: boolean): void {
    this.usagePolling = on
    if (!on) clearTimeout(this.usageAfterTurn)
  }

  /** What focusing the window refreshes: the GitHub identity and git counts. */
  refreshOnFocus(): void {
    void this.refreshGh()
    void this.gitLoop()
  }

  snapshot(): AppSnapshot {
    const s = this.state
    return {
      projects: s.projects,
      sessions: this.sessions.list(),
      agents: this.sessions.listAgents(),
      skills: this.allSkills(),
      mcp: this.allMcp(),
      git: Object.fromEntries(this.gitStats),
      hubPosition: s.hubPosition,
      gh: this.gh,
      models: this.models,
      defaultModel: s.defaultModel,
      efforts: s.efforts,
      optimizePrompts: s.optimizePrompts,
      machineColors: s.machineColors,
      usage: this.usage,
      loops: this.loops.list(),
      autoApprove: this.autoApprove,
      machines: [],
      machinePosition: s.machinePosition ?? { x: s.hubPosition.x, y: s.hubPosition.y - 200 },
      control: this.control,
      notes: s.notes
    }
  }

  /**
   * Files a deleted session or loop referred to. They are deleted shortly after, in one batch,
   * unless another session, loop or remote copy still refers to them (files are stored by content,
   * so two sessions can share one).
   */
  releaseFiles(ids: Iterable<string>): void {
    for (const id of ids) this.released.add(id)
    if (!this.released.size) return
    clearTimeout(this.releaseTimer)
    this.releaseTimer = setTimeout(() => {
      const candidates = [...this.released]
      this.released.clear()
      this.sweepFiles(candidates)
    }, RELEASE_DELAY_MS)
  }

  private sweepFiles(candidates: string[], minAgeMs = 0): void {
    if (!candidates.length) return
    const referenced = this.sessions.assetRefs()
    for (const l of this.loops.list()) for (const id of assetIdsOfLoop(l)) referenced.add(id)
    for (const id of this.extraFileRefs()) referenced.add(id)
    const removed = this.assets.sweep(candidates, referenced, minAgeMs)
    if (removed.length) console.log(`[assets] deleted ${removed.length} file(s) no longer used`)
  }

  /** True while sessions or loops are running or waiting. */
  busy(): boolean {
    return this.sessions.busy() || this.loops.list().some((l) => ['optimizing', 'running', 'waiting'].includes(l.state))
  }

  persist(): void {
    this.state.sessions = this.sessions.list().filter((s) => s.kind !== 'optimize')
    this.state.loops = this.loops.list()
    saveState(this.state)
  }

  project(id: string): Project {
    const p = this.state.projects.find((x) => x.id === id)
    if (!p) throw new Error('Unknown project')
    return p
  }

  // ---------- internals ----------

  private emit(e: MainEvent): void {
    for (const l of this.listeners) l(e)
    // Usage moves when a turn ends; refresh shortly after, once per burst of finishing sessions.
    if (e.type === 'session' && e.session.status === 'finished' && this.usagePolling) {
      clearTimeout(this.usageAfterTurn)
      this.usageAfterTurn = setTimeout(() => void this.refreshUsage(), 5000)
    }
  }

  private allSkills(): SkillInfo[] {
    return [...this.hubSkills, ...[...this.projectConfig.values()].flatMap((c) => c.skills)]
  }

  private allMcp(): McpInfo[] {
    return [...this.hubMcp, ...[...this.projectConfig.values()].flatMap((c) => c.mcp)]
  }

  private emitConfig(): void {
    this.emit({ type: 'config', skills: this.allSkills(), mcp: this.allMcp() })
  }

  private async refreshGit(p: Project): Promise<void> {
    const stats = await getStats(p.path).catch(() => ({ isRepo: false, added: 0, removed: 0, staged: [], unstaged: [] }))
    const prev = this.gitStats.get(p.id)
    if (prev && JSON.stringify(prev) === JSON.stringify(stats)) return
    this.gitStats.set(p.id, stats)
    this.emit({ type: 'git', projectId: p.id, stats })
  }

  /** Runs a git change in a project's folder, then shows its new state. */
  private async gitAction(projectId: string, action: (cwd: string) => Promise<void>): Promise<void> {
    const p = this.project(projectId)
    await action(p.path)
    await this.refreshGit(p)
  }

  private async gitLoop(): Promise<void> {
    if (this.gitLoopRunning) return
    this.gitLoopRunning = true
    try {
      for (const p of [...this.state.projects]) await this.refreshGit(p)
    } finally {
      this.gitLoopRunning = false
    }
  }

  private async refreshHubConfig(): Promise<void> {
    try {
      const result = await inspect(home)
      const loaded = new Map(result.commands.filter((c) => !c.builtin).map((c) => [c.name, c.name]))
      // Synced skills can be listed under a namespaced name (e.g. "anthropic-skills:docs"); match on the suffix.
      const resolveName = (name: string) => loaded.get(name) ?? [...loaded.keys()].find((k) => k.endsWith(`:${name}`))
      this.hubSkills = (await userSkills())
        .map((s) => ({ s, name: resolveName(s.name) }))
        .filter((x) => x.name)
        .map(({ s, name }) => ({ ...s, name: name! }))
      this.hubMcp = result.mcp.filter((s) => !isProjectScoped(s)).map((s) => toMcpInfo(s))
      if (result.models.length) {
        this.models = result.models.map((m) => ({
          value: m.value,
          label: m.displayName,
          efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as EffortLevel[]) : []
        }))
        this.emit({ type: 'models', models: this.models })
      }
    } catch (err) {
      console.error('[config] hub inspect failed', err)
      this.hubSkills = await userSkills()
    }
    this.emitConfig()
  }

  private async refreshProjectConfig(p: Project): Promise<void> {
    const skills = await projectSkills(p.id, p.path)
    let mcp: McpInfo[] = this.projectConfig.get(p.id)?.mcp ?? []
    try {
      mcp = (await inspect(p.path)).mcp.filter(isProjectScoped).map((s) => toMcpInfo(s, p.id))
    } catch (err) {
      console.error('[config] project inspect failed', p.path, err)
    }
    this.projectConfig.set(p.id, { skills, mcp })
    this.emitConfig()
  }

  private async refreshAllConfig(): Promise<void> {
    await Promise.all([this.refreshHubConfig(), ...this.state.projects.map((p) => this.refreshProjectConfig(p))])
  }

  private refreshUsage(): Promise<void> {
    this.usageInFlight ??= readUsage(home)
      .then((u) => {
        // Keep the last good numbers if a refresh fails.
        if (u.error && this.usage && !this.usage.error) return
        this.usage = u
        this.emit({ type: 'usage', usage: u })
      })
      .finally(() => (this.usageInFlight = null))
    return this.usageInFlight
  }

  private async refreshGh(): Promise<void> {
    this.gh = await getAccounts()
    this.emit({ type: 'gh', gh: this.gh })
  }

  private async addProject(path?: string): Promise<Project | null> {
    if (!path) {
      path = (await this.adapters.pickFolder()) ?? undefined
      if (!path) return null
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) return null
    const existing = this.state.projects.find((p) => samePath(p.path, path!))
    if (existing) return existing
    const n = this.state.projects.length
    const p: Project = { id: randomUUID(), path, name: basename(path), position: { x: 260 + (n % 3) * 560, y: -160 + Math.floor(n / 3) * 420 } }
    this.state.projects.push(p)
    saveState(this.state)
    this.emit({ type: 'project', project: p })
    void this.refreshGit(p)
    void this.refreshProjectConfig(p)
    return p
  }

  private async identityFor(cwd: string) {
    const host = await remoteHost(cwd).catch(() => 'github.com')
    return resolveIdentity(host, this.gh)
  }

  /** Drop an effort the model does not accept, so the CLI never receives an invalid level. */
  private effortFor(model: string, effort?: EffortLevel): EffortLevel | undefined {
    const known = this.models.find((m) => m.value === model)
    return effort && (!known || known.efforts.includes(effort)) ? effort : undefined
  }

  private async startPipeline(projectId: string, prompt: string, model: string, requested?: EffortLevel, images: ImageInput[] = [], optimize?: boolean): Promise<void> {
    const { sessions } = this
    const effort = this.effortFor(model, requested)
    const p = this.project(projectId)
    const { identity, env } = await this.identityFor(p.path)
    const startTask = (text: string) => {
      const task = sessions.start({ kind: 'task', anchorId: p.id, projectId: p.id, cwd: p.path, prompt: text, images, model, effort, title: text, identity, env })
      this.emit({ type: 'focus', sessionId: task.id })
      return task
    }
    if (optimize === false) return void startTask(prompt)
    const optimizer = sessions.start({
      kind: 'optimize',
      anchorId: p.id,
      projectId: p.id,
      cwd: p.path,
      prompt: optimizeCommand(prompt, images.length),
      model,
      effort,
      title: prompt,
      identity,
      env,
      onResult: (reply, isError) => {
        if (isError) return // leave the failed optimize node in place so the user can open it
        const optimized = extractOptimizedPrompt(reply)
        const task = startTask(optimized ?? prompt)
        if (!optimized) {
          // Fall back to the original wording rather than stalling the pipeline; say so in the new session.
          sessions.notice(task.id, 'The optimizer reply had no "## Optimized prompt" block, so your original prompt was sent.')
        }
        sessions.markHandedOff(optimizer.id)
        setTimeout(() => sessions.dismiss(optimizer.id), OPTIMIZE_LINGER_MS)
      }
    })
  }

  private async startConfigSession(targetId: string, request: string, model: string, requested?: EffortLevel, images: ImageInput[] = []): Promise<void> {
    const skill = this.allSkills().find((s) => s.id === targetId)
    const mcp = this.allMcp().find((m) => m.id === targetId)
    const proj = (skill?.projectId ?? mcp?.projectId) ? this.project((skill?.projectId ?? mcp?.projectId)!) : null
    const cwd = proj?.path ?? home
    let prompt: string
    let title: string
    if (skill) {
      title = `${skill.name}: ${request}`
      prompt = [
        `Change the Claude Code skill "${skill.name}". Its definition is ${skill.path} (${skill.scope} scope).`,
        skill.scope === 'plugin' ? 'It ships with an installed plugin, so edits in the plugin cache can be overwritten by a plugin update; mention that if it matters for this change.' : '',
        skill.scope === 'synced' ? 'It is synced from claude.ai, so local edits can be overwritten by the next sync; mention that if it matters for this change.' : '',
        '',
        `Requested change: ${request}`,
        '',
        'Edit the skill markdown (and files next to it, if the change needs that) and run whatever commands are needed.'
      ].filter((l, i, a) => l || a[i - 1]).join('\n')
    } else if (mcp) {
      title = `${mcp.name}: ${request}`
      const where =
        mcp.scope === 'project'
          ? `${join(cwd, '.mcp.json')}`
          : mcp.scope === 'local'
            ? `${claudeJsonPath} under projects["${cwd}"].mcpServers`
            : mcp.scope === 'user'
              ? `${claudeJsonPath} under mcpServers`
              : `the ${mcp.source ?? mcp.scope} configuration (not a local file Claude Code owns)`
      prompt = [
        `Change the MCP server "${mcp.name}" that Claude Code uses. It is configured in ${where} (scope: ${mcp.scope ?? 'unknown'}).`,
        `Current status: ${mcp.status}${mcp.error ? ` (${mcp.error})` : ''}.`,
        '',
        `Requested change: ${request}`,
        '',
        'Use `claude mcp` commands or edit the configuration directly, and run whatever commands are needed. Do not print secret values from the configuration.'
      ].join('\n')
    } else throw new Error('Unknown skill or MCP server')

    const { identity, env } = await this.identityFor(cwd)
    const s = this.sessions.start({
      kind: 'config',
      anchorId: targetId,
      projectId: proj?.id ?? null,
      cwd,
      prompt,
      images,
      model,
      effort: this.effortFor(model, requested),
      title,
      identity,
      env,
      onResult: () => void (proj ? this.refreshProjectConfig(proj) : this.refreshHubConfig())
    })
    this.emit({ type: 'focus', sessionId: s.id })
  }

  private createHandlers(): CoreApi {
    const { sessions, terminals, loops } = this
    const project = (id: string) => this.project(id)
    return {
      snapshot: async () => this.snapshot(),
      addProject: (path) => this.addProject(path),
      removeProject: async (id) => {
        for (const l of loops.list()) if (l.projectId === id) loops.delete(l.id)
        for (const s of sessions.list()) if (s.projectId === id) sessions.dismiss(s.id)
        this.state.projects = this.state.projects.filter((p) => p.id !== id)
        this.projectConfig.delete(id)
        this.gitStats.delete(id)
        saveState(this.state)
        this.emit({ type: 'projectRemoved', id })
        this.emitConfig()
      },
      moveNode: async (id, position: Point) => {
        if (id === USER_HUB_ID) this.state.hubPosition = position
        const p = this.state.projects.find((x) => x.id === id)
        if (p) p.position = position
        const s = sessions.get(id)
        if (s) s.position = position
        const l = loops.list().find((x) => x.id === id)
        if (l) l.position = position
        const n = this.state.notes.find((x) => x.id === id)
        if (n) n.position = position
        this.persist()
      },
      setMachineColor: async (machineId, color) => {
        if (color) this.state.machineColors[machineId] = color
        else delete this.state.machineColors[machineId]
        saveState(this.state)
      },
      noteCreate: async (position) => {
        const n: Note = { id: randomUUID(), text: '', position }
        this.state.notes.push(n)
        saveState(this.state)
        this.emit({ type: 'note', note: n })
        return n
      },
      noteUpdate: async (id, text) => {
        const n = this.state.notes.find((x) => x.id === id)
        if (!n) throw new Error('Unknown note')
        n.text = text
        saveState(this.state)
        this.emit({ type: 'note', note: n })
      },
      noteDelete: async (id) => {
        this.state.notes = this.state.notes.filter((x) => x.id !== id)
        saveState(this.state)
        this.emit({ type: 'noteRemoved', id })
      },
      startPipeline: (...a) => this.startPipeline(...a),
      startConfigSession: (...a) => this.startConfigSession(...a),
      sendMessage: async (id, text, images) => sessions.send(id, text, images),
      stopSession: (id) => sessions.stop(id),
      dismissSession: async (id) => sessions.dismiss(id),
      transcript: async (id) => sessions.transcript(id),
      respondApproval: async (id, requestId, decision, message) => (sessions.respondApproval(id, requestId, decision, message) ? null : 'Already answered.'),
      respondQuestion: async (id, requestId, answers) => (sessions.respondQuestion(id, requestId, answers) ? null : 'Already answered.'),
      gitStats: async (projectId) => {
        await this.refreshGit(project(projectId))
        return this.gitStats.get(projectId)!
      },
      gitFileDiff: (projectId, file, staged) => getFileDiff(project(projectId).path, file, staged),
      gitBranches: (projectId) => listBranches(project(projectId).path),
      gitSwitch: (projectId, branch) => this.gitAction(projectId, (cwd) => switchBranch(cwd, branch)),
      gitStage: (projectId, paths) => this.gitAction(projectId, (cwd) => stage(cwd, paths)),
      gitUnstage: (projectId, paths) => this.gitAction(projectId, (cwd) => unstage(cwd, paths)),
      gitCommit: (projectId, message) => this.gitAction(projectId, (cwd) => commitStaged(cwd, message)),
      readSkill: async (skillId) => {
        const skill = this.allSkills().find((s) => s.id === skillId)
        if (!skill) throw new Error('Unknown skill')
        return { path: skill.path, content: await readFile(skill.path, 'utf8') }
      },
      readClaudeMd: (projectId) => readClaudeMd(project(projectId).path),
      writeClaudeMd: (projectId, content) => writeClaudeMd(project(projectId).path, content),
      refreshConfig: () => this.refreshAllConfig(),
      ghLogin: async () => {
        login(
          (prompt) => {
            this.emit({ type: 'login', prompt })
            if (prompt.done) void this.refreshGh()
          },
          // While another machine controls this one, the person is there: that machine opens the page.
          (url) => !this.control && this.adapters.openExternal(url)
        )
      },
      setDefaultModel: async (model) => {
        this.state.defaultModel = model
        saveState(this.state)
      },
      setModelEffort: async (model, effort) => {
        if (effort) this.state.efforts[model] = effort
        else delete this.state.efforts[model]
        saveState(this.state)
      },
      setOptimizePrompts: async (on) => {
        this.state.optimizePrompts = on
        saveState(this.state)
      },
      refreshUsage: () => this.refreshUsage(),
      termStart: async (id, projectId, cols, rows) => terminals.start(id, projectId ? project(projectId).path : home, cols, rows),
      termWrite: async (id, data) => terminals.write(id, data),
      termResize: async (id, cols, rows) => terminals.resize(id, cols, rows),
      termKill: async (id) => terminals.kill(id),
      loopCreate: async (projectId, draft) => loops.create(projectId, draft),
      loopUpdate: async (id, draft) => loops.update(id, draft),
      loopDelete: async (id) => loops.delete(id),
      loopStart: (id) => loops.start(id),
      loopStop: async (id) => loops.stop(id),
      loopDecide: (id, decision) => loops.decide(id, decision),
      openArtifact: (projectId, artifact) => this.adapters.openArtifact(project(projectId).path, artifact),
      asset: (_ownerId, assetId) => this.assets.dataUrl(assetId),
      openAsset: async (_ownerId, assetId) => {
        const path = this.assets.path(assetId)
        return path ? this.adapters.openPath(path) : 'That file is no longer stored.'
      },
      setAutoApprove: async (on) => {
        this.autoApprove = on
        sessions.setAutoApprove(on)
        this.emit({ type: 'autoApprove', on })
      },
      micAccess: () => this.adapters.micAccess(),
      refineDictation: (text) => refineDictation(text),
      dictationLanguage: () => dictationLanguage(),
      claudeLogin: async (id, cols, rows) => {
        const file = claudeExecutable()
        if (!file) throw new Error('The Claude Code binary that ships with Symphony was not found. Run npm install again.')
        return terminals.start(id, home, cols, rows, { file, args: ['/login'], name: 'Sign in to Claude' })
      }
    }
  }
}
