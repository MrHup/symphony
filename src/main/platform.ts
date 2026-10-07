// Everything that differs between Windows and macOS lives here: config locations, PATH repair,
// process spawning, gh lookup and the git credential wiring that makes sessions use a gh account.
// Other modules must not branch on process.platform themselves. The Electron APIs the core needs
// are handed to it as adapters from here too.
import { dialog, powerMonitor, powerSaveBlocker, safeStorage, shell, systemPreferences, type BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MachineHealth } from '@shared/types'

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'

export const home = homedir()

/** Claude Code's user config directory (honours CLAUDE_CONFIG_DIR like the CLI does). */
export const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')

/** ~/.claude.json holds user- and local-scope MCP servers. */
export const claudeJsonPath = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : join(home, '.claude.json')

/** Key Claude Code uses for a project inside ~/.claude.json `projects` (forward slashes on Windows). */
export function claudeJsonProjectKeys(projectPath: string): string[] {
  if (!isWindows) return [projectPath]
  const fwd = projectPath.replace(/\\/g, '/')
  // The drive letter's case varies between entries, so match both.
  const lower = fwd.charAt(0).toLowerCase() + fwd.slice(1)
  const upper = fwd.charAt(0).toUpperCase() + fwd.slice(1)
  return [...new Set([fwd, lower, upper, projectPath])]
}

/** Case-insensitive path comparison on Windows, exact elsewhere. macOS volumes are usually case-insensitive too, but not always. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return isWindows ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/**
 * A GUI app on macOS starts with launchd's minimal PATH, so git, gh and MCP server commands
 * installed by Homebrew would not be found. Ask the login shell for the real PATH once at startup.
 */
export async function repairPath(): Promise<void> {
  if (isWindows) return
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__SYMPHONY_PATH__'
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    })
    const match = out.match(new RegExp(`${marker}(.*)${marker}`))
    if (match?.[1]) process.env.PATH = match[1]
  } catch {
    // Keep launchd's PATH plus the usual Homebrew locations.
    process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':')
  }
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a program without a shell and collect its output. Never throws for a non-zero exit. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? String(err.message) : '') })
      }
    )
  })
}

/** Long-running child with piped stdio and no console window. */
export function spawnPiped(file: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(file, args, { env: env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

function findOnPath(name: string): string | null {
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(isWindows ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
      const upper = join(dir, name + ext)
      if (existsSync(upper)) return upper
    }
  }
  return null
}

const ghCandidates = isWindows
  ? [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'GitHub CLI', 'gh.exe')
    ]
  : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

let ghCache: string | null | undefined

/** Path to gh, or null when it is not installed. A fresh winget install is not on an already-running app's PATH, hence the fallbacks. */
export function ghPath(): string | null {
  if (ghCache !== undefined) return ghCache
  ghCache = findOnPath('gh') ?? ghCandidates.find((p) => existsSync(p)) ?? null
  return ghCache
}

/**
 * The shell for the embedded terminal: PowerShell. On Windows that is PowerShell 7 (pwsh) when
 * installed, else Windows PowerShell. On macOS it is pwsh when installed, else the login shell.
 */
export function terminalShell(): { file: string; args: string[] } {
  const pwsh = findOnPath('pwsh')
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] }
  if (isWindows) return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

export function gitPath(): string {
  return findOnPath('git') ?? 'git'
}

/**
 * Environment that makes git inside a session authenticate to `host` through gh, and makes gh
 * itself use the given token. Uses GIT_CONFIG_COUNT so nothing is written to the user's git config.
 */
export function ghCredentialEnv(host: string, token: string): Record<string, string> {
  const gh = ghPath()
  const env: Record<string, string> = { GH_TOKEN: token }
  if (host !== 'github.com') env.GH_ENTERPRISE_TOKEN = token
  if (!gh) return env
  // git runs credential helpers through sh (Git for Windows ships one), so forward slashes and quoting work on both OSes.
  const helper = `!'${gh.replace(/\\/g, '/')}' auth git-credential`
  const key = `credential.https://${host}.helper`
  Object.assign(env, {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: '', // clears helpers inherited from the user's config for this host
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: helper
  })
  return env
}

/** macOS apps stay running with no windows open; Windows apps quit. */
export const quitWhenAllWindowsClosed = !isMac

/** Title-bar options so the dark canvas runs edge to edge: inset traffic lights on macOS, overlay window controls on Windows. */
export function windowChrome(background: string, foreground: string): Electron.BrowserWindowConstructorOptions {
  if (isMac) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: background, symbolColor: foreground, height: 36 } }
}

/**
 * The Claude Code binary that ships with the Agent SDK for this OS/CPU. In a packaged app the
 * binary is unpacked from the asar archive, so point at the unpacked copy.
 */
export function claudeExecutable(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const bin = join(dirname(pkg), isWindows ? 'claude.exe' : 'claude').replace(`app.asar${isWindows ? '\\' : '/'}`, `app.asar.unpacked${isWindows ? '\\' : '/'}`)
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

/**
 * File types that open in a viewer, never as a program. Artifact paths come from agent output, and
 * "open with the default app" would run executables and scripts (.exe, .bat, .ps1, and on Windows
 * even .js and .vbs through Windows Script Host), so everything else is only shown in its folder.
 */
const VIEWABLE = new Set([
  '.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.md', '.txt', '.log', '.csv', '.json', '.xml', '.yml', '.yaml'
])

export const isViewable = (path: string) => VIEWABLE.has(extname(path).toLowerCase())

/** An artifact's file path, absolute or relative to the project folder; null for a link that is not a file. */
export function artifactPath(baseDir: string, target: { path?: string; url?: string }): string | null {
  const path = target.url && /^file:/i.test(target.url) ? fileURLToPath(target.url) : target.path
  if (!path) return null
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

/** Open a handed-over file or link. Returns an error message, or null on success. */
export async function openArtifact(baseDir: string, target: { path?: string; url?: string }): Promise<string | null> {
  if (target.url && !/^file:/i.test(target.url)) {
    if (/^https?:\/\//i.test(target.url)) {
      await shell.openExternal(target.url)
      return null
    }
    return 'Only http, https and file links can be opened.'
  }
  const full = artifactPath(baseDir, target)
  if (!full) return 'Nothing to open.'
  if (!existsSync(full)) return `${full} does not exist.`
  if (!isViewable(full)) {
    shell.showItemInFolder(full)
    return null
  }
  const err = await shell.openPath(full)
  return err || null
}

/** macOS asks the user once for microphone access; Windows grants it through its own privacy settings. */
export async function ensureMicAccess(): Promise<boolean> {
  if (!isMac) return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
}

// ---------- adapters for the core ----------

/** The Electron features the core uses, injected so the core itself stays plain Node. */
export interface Adapters {
  /** The native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>
  openExternal(url: string): void
  /** Opens a local file in its default app; returns an error message or null. */
  openPath(path: string): Promise<string | null>
  openArtifact(baseDir: string, target: { path?: string; url?: string }): Promise<string | null>
  micAccess(): Promise<boolean>
}

export function electronAdapters(win: () => BrowserWindow | null): Adapters {
  return {
    async pickFolder() {
      const w = win()
      const res = w ? await dialog.showOpenDialog(w, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    },
    openExternal: (url) => void shell.openExternal(url),
    openPath: async (path) => (await shell.openPath(path)) || null,
    openArtifact,
    micAccess: ensureMicAccess
  }
}

// ---------- remote orchestration ----------

/** Encrypt a secret with the OS store (Keychain on macOS, DPAPI on Windows). Needs the app to be ready. */
export function sealSecret(text: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is not available, so the device key cannot be stored.')
  return safeStorage.encryptString(text).toString('base64')
}

export function openSecret(sealed: string): string {
  return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
}

let nameCache: string | undefined

/** This machine's display name, e.g. "MacBook Pro of Ana" (SYMPHONY_MACHINE_NAME overrides it for tests). */
export async function machineName(): Promise<string> {
  if (nameCache) return nameCache
  let name = process.env.SYMPHONY_MACHINE_NAME?.trim() || ''
  if (!name && isMac) name = (await run('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeoutMs: 3000 })).stdout.trim()
  if (!name && isWindows) name = process.env.COMPUTERNAME ?? ''
  nameCache = name || hostname().replace(/\.local$/, '')
  return nameCache
}

/** Battery and power state. The percentage comes from `pmset` on macOS and is unknown elsewhere. */
export async function readHealth(): Promise<MachineHealth> {
  const onBattery = powerMonitor.isOnBatteryPower()
  if (!isMac) return { battery: null, charging: !onBattery, lowPower: false }
  const [batt, settings] = await Promise.all([run('/usr/bin/pmset', ['-g', 'batt'], { timeoutMs: 3000 }), run('/usr/bin/pmset', ['-g'], { timeoutMs: 3000 })])
  const pct = batt.stdout.match(/(\d+)%/)
  return {
    battery: pct ? Number(pct[1]) : null,
    charging: !onBattery,
    lowPower: /lowpowermode\s+1/.test(settings.stdout)
  }
}

/** Power events: about to sleep, woke up, switched between battery and mains. */
export function onPower(handlers: { suspend(): void; resume(): void; change(): void }): void {
  powerMonitor.on('suspend', handlers.suspend)
  powerMonitor.on('resume', handlers.resume)
  powerMonitor.on('on-battery', handlers.change)
  powerMonitor.on('on-ac', handlers.change)
}

let blocker: number | null = null

/** While on, idle sleep is prevented (a closed lid still sleeps the machine). */
export function keepAwake(on: boolean): void {
  if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!on && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}
