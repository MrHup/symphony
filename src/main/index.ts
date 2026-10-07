import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { InvokeApi } from '@shared/api'
import { USER_HUB_ID, type AppSnapshot, type EffortLevel, type ImageInput, type UsageInfo, type GhAccounts, type GitStats, type McpInfo, type MainEvent, type ModelOption, type Project, type SkillInfo } from '@shared/types'
import { inspect, isProjectScoped, projectSkills, readClaudeMd, readUsage, toMcpInfo, userSkills, writeClaudeMd } from './claudeConfig'
import { TerminalManager } from './terminals'
import { getFileDiff, getStats, remoteHost } from './git'
import { getAccounts, login, resolveIdentity } from './github'
import { extractOptimizedPrompt, OPTIMIZE_LINGER_MS, optimizeCommand } from './pipeline'
import { claudeJsonPath, home, quitWhenAllWindowsClosed, repairPath, samePath, windowChrome } from './platform'
import { SessionManager } from './sessions'
import { loadState, saveState, type PersistedState } from './store'

const CHARCOAL = '#131312'
const BONE = '#e9e5dc'
const GIT_POLL_MS = 4000
const CONFIG_POLL_MS = 3 * 60_000
const USAGE_POLL_MS = 2 * 60_000

const here = fileURLToPath(new URL('.', import.meta.url))

// Lets test runs keep their graph and transcripts away from the real profile.
if (process.env.SYMPHONY_USER_DATA) app.setPath('userData', process.env.SYMPHONY_USER_DATA)

let win: BrowserWindow | null = null
let state: PersistedState
let gh: GhAccounts = { installed: false, hosts: {} }
let models: ModelOption[] = []
let hubSkills: SkillInfo[] = []
let hubMcp: McpInfo[] = []
const projectConfig = new Map<string, { skills: SkillInfo[]; mcp: McpInfo[] }>()
const gitStats = new Map<string, GitStats>()
let usage: UsageInfo | null = null

let usageAfterTurn: NodeJS.Timeout | undefined

function emit(e: MainEvent): void {
  win?.webContents.send('symphony:event', e)
  // Usage moves when a turn ends; refresh shortly after, once per burst of finishing sessions.
  if (e.type === 'session' && e.session.status === 'finished') {
    clearTimeout(usageAfterTurn)
    usageAfterTurn = setTimeout(() => void refreshUsage(), 5000)
  }
}

const sessions = new SessionManager(emit, () => persist())
const terminals = new TerminalManager(emit)

function persist(): void {
  state.sessions = sessions.list().filter((s) => s.kind !== 'optimize')
  saveState(state)
}

function project(id: string): Project {
  const p = state.projects.find((x) => x.id === id)
  if (!p) throw new Error('Unknown project')
  return p
}

function allSkills(): SkillInfo[] {
  return [...hubSkills, ...[...projectConfig.values()].flatMap((c) => c.skills)]
}

function allMcp(): McpInfo[] {
  return [...hubMcp, ...[...projectConfig.values()].flatMap((c) => c.mcp)]
}

function emitConfig(): void {
  emit({ type: 'config', skills: allSkills(), mcp: allMcp() })
}

// ---------- background refresh ----------

async function refreshGit(p: Project): Promise<void> {
  const stats = await getStats(p.path).catch(() => ({ isRepo: false, added: 0, removed: 0, files: [] }))
  const prev = gitStats.get(p.id)
  if (prev && JSON.stringify(prev) === JSON.stringify(stats)) return
  gitStats.set(p.id, stats)
  emit({ type: 'git', projectId: p.id, stats })
}

let gitLoopRunning = false
async function gitLoop(): Promise<void> {
  if (gitLoopRunning) return
  gitLoopRunning = true
  try {
    for (const p of [...state.projects]) await refreshGit(p)
  } finally {
    gitLoopRunning = false
  }
}

async function refreshHubConfig(): Promise<void> {
  try {
    const result = await inspect(home)
    const loaded = new Map(result.commands.filter((c) => !c.builtin).map((c) => [c.name, c.name]))
    // Synced skills can be listed under a namespaced name (e.g. "anthropic-skills:docs"); match on the suffix.
    const resolveName = (name: string) => loaded.get(name) ?? [...loaded.keys()].find((k) => k.endsWith(`:${name}`))
    hubSkills = (await userSkills())
      .map((s) => ({ s, name: resolveName(s.name) }))
      .filter((x) => x.name)
      .map(({ s, name }) => ({ ...s, name: name! }))
    hubMcp = result.mcp.filter((s) => !isProjectScoped(s)).map((s) => toMcpInfo(s))
    if (result.models.length) {
      models = result.models.map((m) => ({
        value: m.value,
        label: m.displayName,
        efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as EffortLevel[]) : []
      }))
      emit({ type: 'models', models })
    }
  } catch (err) {
    console.error('[config] hub inspect failed', err)
    hubSkills = await userSkills()
  }
  emitConfig()
}

async function refreshProjectConfig(p: Project): Promise<void> {
  const skills = await projectSkills(p.id, p.path)
  let mcp: McpInfo[] = projectConfig.get(p.id)?.mcp ?? []
  try {
    mcp = (await inspect(p.path)).mcp.filter(isProjectScoped).map((s) => toMcpInfo(s, p.id))
  } catch (err) {
    console.error('[config] project inspect failed', p.path, err)
  }
  projectConfig.set(p.id, { skills, mcp })
  emitConfig()
}

async function refreshAllConfig(): Promise<void> {
  await Promise.all([refreshHubConfig(), ...state.projects.map(refreshProjectConfig)])
}

let usageInFlight: Promise<void> | null = null
function refreshUsage(): Promise<void> {
  usageInFlight ??= readUsage(home)
    .then((u) => {
      // Keep the last good numbers if a refresh fails.
      if (u.error && usage && !usage.error) return
      usage = u
      emit({ type: 'usage', usage })
    })
    .finally(() => (usageInFlight = null))
  return usageInFlight
}

async function refreshGh(): Promise<void> {
  gh = await getAccounts()
  emit({ type: 'gh', gh })
}

// ---------- actions ----------

async function addProject(path?: string): Promise<Project | null> {
  if (!path) {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    path = res.filePaths[0]
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) return null
  const existing = state.projects.find((p) => samePath(p.path, path!))
  if (existing) return existing
  const n = state.projects.length
  const p: Project = { id: randomUUID(), path, name: basename(path), position: { x: 260 + (n % 3) * 560, y: -160 + Math.floor(n / 3) * 420 } }
  state.projects.push(p)
  saveState(state)
  emit({ type: 'project', project: p })
  void refreshGit(p)
  void refreshProjectConfig(p)
  return p
}

async function identityFor(cwd: string) {
  const host = await remoteHost(cwd).catch(() => 'github.com')
  return resolveIdentity(host, gh)
}

/** Drop an effort the model does not accept, so the CLI never receives an invalid level. */
function effortFor(model: string, effort?: EffortLevel): EffortLevel | undefined {
  const known = models.find((m) => m.value === model)
  return effort && (!known || known.efforts.includes(effort)) ? effort : undefined
}

async function startPipeline(projectId: string, prompt: string, model: string, requested?: EffortLevel, images: ImageInput[] = []): Promise<void> {
  const effort = effortFor(model, requested)
  const p = project(projectId)
  const { identity, env } = await identityFor(p.path)
  const optimize = sessions.start({
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
      const task = sessions.start({
        kind: 'task',
        anchorId: p.id,
        projectId: p.id,
        cwd: p.path,
        prompt: optimized ?? prompt,
        images,
        model,
        effort,
        title: optimized ?? prompt,
        identity,
        env
      })
      if (!optimized) {
        // Fall back to the original wording rather than stalling the pipeline; say so in the new session.
        sessions.notice(task.id, 'The optimizer reply had no "## Optimized prompt" block, so your original prompt was sent.')
      }
      emit({ type: 'focus', sessionId: task.id })
      sessions.markHandedOff(optimize.id)
      setTimeout(() => sessions.dismiss(optimize.id), OPTIMIZE_LINGER_MS)
    }
  })
}

async function startConfigSession(targetId: string, request: string, model: string, requested?: EffortLevel, images: ImageInput[] = []): Promise<void> {
  const skill = allSkills().find((s) => s.id === targetId)
  const mcp = allMcp().find((m) => m.id === targetId)
  const proj = (skill?.projectId ?? mcp?.projectId) ? project((skill?.projectId ?? mcp?.projectId)!) : null
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

  const { identity, env } = await identityFor(cwd)
  const s = sessions.start({
    kind: 'config',
    anchorId: targetId,
    projectId: proj?.id ?? null,
    cwd,
    prompt,
    images,
    model,
    effort: effortFor(model, requested),
    title,
    identity,
    env,
    onResult: () => void (proj ? refreshProjectConfig(proj) : refreshHubConfig())
  })
  emit({ type: 'focus', sessionId: s.id })
}

function snapshot(): AppSnapshot {
  return {
    projects: state.projects,
    sessions: sessions.list(),
    agents: sessions.listAgents(),
    skills: allSkills(),
    mcp: allMcp(),
    git: Object.fromEntries(gitStats),
    hubPosition: state.hubPosition,
    gh,
    models,
    defaultModel: state.defaultModel,
    efforts: state.efforts,
    usage
  }
}

const handlers: InvokeApi = {
  snapshot: async () => snapshot(),
  addProject,
  async removeProject(id) {
    for (const s of sessions.list()) if (s.projectId === id) sessions.dismiss(s.id)
    state.projects = state.projects.filter((p) => p.id !== id)
    projectConfig.delete(id)
    gitStats.delete(id)
    saveState(state)
    emit({ type: 'projectRemoved', id })
    emitConfig()
  },
  async moveNode(id, position) {
    if (id === USER_HUB_ID) state.hubPosition = position
    const p = state.projects.find((x) => x.id === id)
    if (p) p.position = position
    const s = sessions.get(id)
    if (s) s.position = position
    persist()
  },
  startPipeline,
  startConfigSession,
  sendMessage: async (id, text, images) => sessions.send(id, text, images),
  stopSession: (id) => sessions.stop(id),
  dismissSession: async (id) => sessions.dismiss(id),
  transcript: async (id) => sessions.transcript(id),
  respondApproval: async (id, requestId, decision, message) => sessions.respondApproval(id, requestId, decision, message),
  respondQuestion: async (id, requestId, answers) => sessions.respondQuestion(id, requestId, answers),
  async gitStats(projectId) {
    await refreshGit(project(projectId))
    return gitStats.get(projectId)!
  },
  gitFileDiff: (projectId, file) => getFileDiff(project(projectId).path, file),
  async readSkill(skillId) {
    const skill = allSkills().find((s) => s.id === skillId)
    if (!skill) throw new Error('Unknown skill')
    return { path: skill.path, content: await readFile(skill.path, 'utf8') }
  },
  readClaudeMd: (projectId) => readClaudeMd(project(projectId).path),
  writeClaudeMd: (projectId, content) => writeClaudeMd(project(projectId).path, content),
  refreshConfig: () => refreshAllConfig(),
  async ghLogin() {
    login(
      (prompt) => {
        emit({ type: 'login', prompt })
        if (prompt.done) void refreshGh()
      },
      (url) => void shell.openExternal(url)
    )
  },
  async setDefaultModel(model) {
    state.defaultModel = model
    saveState(state)
  },
  async setModelEffort(model, effort) {
    if (effort) state.efforts[model] = effort
    else delete state.efforts[model]
    saveState(state)
  },
  refreshUsage: () => refreshUsage(),
  termStart: async (id, projectId, cols, rows) => terminals.start(id, projectId ? project(projectId).path : home, cols, rows),
  termWrite: async (id, data) => terminals.write(id, data),
  termResize: async (id, cols, rows) => terminals.resize(id, cols, rows),
  termKill: async (id) => terminals.kill(id)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: CHARCOAL,
    title: 'Symphony',
    ...windowChrome(CHARCOAL, BONE),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('focus', () => {
    void refreshGh()
    void gitLoop()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  await repairPath()
  state = loadState()
  sessions.restore(state.sessions)
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`symphony:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  createWindow()
  void refreshGh()
  void gitLoop()
  void refreshAllConfig()
  void refreshUsage()
  setInterval(() => void gitLoop(), GIT_POLL_MS)
  setInterval(() => void refreshUsage(), USAGE_POLL_MS)
  setInterval(() => void refreshAllConfig(), CONFIG_POLL_MS)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (quitWhenAllWindowsClosed) app.quit()
})

app.on('before-quit', () => {
  persist()
  sessions.closeAll()
  terminals.killAll()
})
