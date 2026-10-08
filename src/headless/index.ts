// Symphony without Electron: turns this machine into a remote machine that a Symphony orchestrator
// drives over the local network, for machines that cannot run the app. There is no window; it is
// the same core and the same link as the app's remote mode (src/main/remote/link.ts), set up from
// the command line. Run through scripts/headless.mjs, which puts src/headless/electron.ts in place
// of Electron.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { LinkState, RemoteStatus } from '@shared/types'
import { SymphonyCore } from '../main/core'
import { claudeExecutable, home, machineName, onPower, repairPath, type Adapters } from '../main/platform'
import { deviceIdentity, existingIdentityId } from '../main/remote/identity'
import { RemoteLink } from '../main/remote/link'
import { loadSettings, readAudit, saveSettings, type RemoteSettings } from '../main/remote/settings'
import { flushAll, setDataDir } from '../main/store'

declare const SYMPHONY_VERSION: string

const USAGE = `Symphony headless: this machine as a remote machine of a Symphony orchestrator, without Electron.

  npm run headless -- <command>

  pair [address]          Pair with an orchestrator (found on the network, or at host[:port]), then serve it
  run                     Serve the paired orchestrator (the default)
  share [folder ...]      Show or set the folders the orchestrator may add projects from
  terminals on|off        Let the orchestrator open terminals here
  unpair                  Forget the paired orchestrator
  status                  Show this machine's settings
  log                     Show what the orchestrator did here
  login                   Sign in to Claude Code with the binary that ships with Symphony

Settings are read when the client starts: stop it before changing them.
Data folder: SYMPHONY_USER_DATA, or ~/.symphony-headless.`

const DISCOVERY_MS = 6000
const NO_WINDOW = 'This machine has no window; open it from the orchestrator.'

/** The window's features, which a headless machine does not have. The orchestrator opens files on its side. */
const adapters: Adapters = {
  pickFolder: async () => null,
  openExternal: (url) => console.log(`Open in a browser: ${url}`),
  openPath: async () => NO_WINDOW,
  openArtifact: async () => NO_WINDOW,
  micAccess: async () => false,
  thumbnail: async () => null
}

const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`)

async function main(): Promise<void> {
  const [cmd = 'run', ...args] = process.argv.slice(2)
  const dir = process.env.SYMPHONY_USER_DATA || join(home, '.symphony-headless')
  // Only this user can read the folder: the device key is stored in it (see electron.ts).
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  setDataDir(dir)
  const settings = loadSettings()
  const save = async () => {
    saveSettings(settings)
    await flushAll()
  }

  switch (cmd) {
    case 'run':
      if (!settings.orchestrator) throw new Error('Not paired with an orchestrator yet. Run: npm run headless -- pair [address]')
      return serve(settings)
    case 'pair':
      return serve(settings, args[0] ?? null)
    case 'share': {
      if (args.length) {
        const folders = args.map((f) => resolve(f))
        const bad = folders.find((f) => !existsSync(f) || !statSync(f).isDirectory())
        if (bad) throw new Error(`${bad} is not a folder.`)
        settings.sharedFolders = [...new Set(folders)]
        await save()
      }
      return console.log(settings.sharedFolders.join('\n'))
    }
    case 'terminals':
      if (args[0] !== 'on' && args[0] !== 'off') throw new Error('Usage: terminals on|off')
      settings.terminals = args[0] === 'on'
      await save()
      return console.log(`Terminals ${args[0]}.`)
    case 'unpair':
      settings.orchestrator = null
      await save()
      return console.log('Forgotten. The orchestrator still lists this machine until it is revoked there.')
    case 'status': {
      const pc = settings.orchestrator
      return console.log(
        [
          `Machine         ${await machineName()}`,
          `Machine id      ${existingIdentityId() ?? '(made when pairing)'}`,
          `Orchestrator    ${pc ? `${pc.name} at ${pc.host}:${pc.port}` : 'not paired'}`,
          `Shared folders  ${settings.sharedFolders.join(', ')}`,
          `Terminals       ${settings.terminals ? 'on' : 'off'}`,
          `Claude Code     ${claudeExecutable() ?? 'bundled binary not found: run npm install'}`,
          `Data folder     ${dir}`
        ].join('\n')
      )
    }
    case 'log':
      return console.log(readAudit().map((e) => `${new Date(e.at).toLocaleString()}  ${e.action}${e.detail ? `: ${e.detail}` : ''}`).join('\n') || 'Nothing yet.')
    case 'login': {
      const file = claudeExecutable()
      if (!file) throw new Error('The Claude Code binary that ships with Symphony was not found. Run npm install again.')
      const child = spawn(file, ['/login'], { stdio: 'inherit' })
      return new Promise((done) => child.on('exit', () => done()))
    }
    default:
      console.log(USAGE)
      process.exitCode = cmd === 'help' || cmd === '--help' ? 0 : 1
  }
}

/** Run the core and the link until stopped. With `pair`, pair first (null: find the orchestrator on the network). */
async function serve(settings: RemoteSettings, pair?: string | null): Promise<void> {
  await repairPath()
  // A headless machine is always in remote mode: that is all it is for. Pairing starts afresh.
  settings.remoteMode = true
  if (pair !== undefined) settings.orchestrator = null
  saveSettings(settings)
  const identity = await deviceIdentity()
  const name = await machineName()
  const core = new SymphonyCore(adapters)
  core.start()

  let shown = ''
  let asked = ''
  let prev: LinkState = 'off'
  let ended = false
  const link: RemoteLink = new RemoteLink(core, settings, () => {
    const s = link.status()
    const line = describe(s)
    if (line && line !== shown) log((shown = line))
    if (s.pairing && s.pairing.code !== asked) void confirmPairing((asked = s.pairing.code), s.pairing.name)
    // Revoked, or a pairing that failed: there is nothing left to serve.
    if (s.state === 'unpaired' && !s.pairing && (s.error || (prev !== 'off' && prev !== 'unpaired'))) stop(s.error ?? 'This machine is not paired with an orchestrator.', s.error ? 1 : 0)
    prev = s.state
  })

  const confirmPairing = async (code: string, peer: string) => {
    log(`Pairing with ${peer}. Code: ${code.slice(0, 3)} ${code.slice(3)}`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => stop())
    const answer = await rl.question('Does the orchestrator show the same code? Accept on both sides. [y/N] ').catch(() => '')
    rl.close()
    if (link.status().pairing?.code !== code) return
    link.pairDecision(/^y(es)?$/i.test(answer.trim()))
  }

  const stop = (why?: string, code = 0) => {
    if (ended) return
    ended = true
    if (why) log(why)
    process.exitCode = code
    link.shutdown('quit')
    core.shutdown()
    // Give the goodbye frame and pending writes a moment to go out.
    void Promise.all([flushAll(), new Promise((r) => setTimeout(r, 200))]).finally(() => process.exit())
  }
  process.on('SIGINT', () => stop())
  process.on('SIGTERM', () => stop())

  log(`${name} serves its orchestrator; Ctrl+C stops it. Shared folders: ${settings.sharedFolders.join(', ')}`)
  link.start(identity, name, SYMPHONY_VERSION)
  onPower({ suspend: () => link.onSuspend(), resume: () => link.onResume(), change: () => link.onPowerChange() })
  if (pair === undefined) return

  let address = pair
  if (!address) {
    log('Looking for orchestrators on the network...')
    await new Promise((r) => setTimeout(r, DISCOVERY_MS))
    const found = link.status().discovered
    if (found.length !== 1) {
      const list = found.map((d) => `  ${d.name}  ${d.host}:${d.port}`).join('\n')
      return stop(found.length ? `Several orchestrators found; pick one:\n${list}\n  npm run headless -- pair <address>` : 'No orchestrator found. Turn on "Orchestrate other machines" there, or give its address.', 1)
    }
    address = `${found[0].host}:${found[0].port}`
  }
  log(`Asking ${address} to pair...`)
  link.pair(address, identity)
}

function describe(s: RemoteStatus['remote']): string {
  const pc = s.pc ? `${s.pc.name} (${s.pc.host}:${s.pc.port})` : ''
  switch (s.state) {
    case 'connected':
      return `Linked to ${pc}.`
    case 'connecting':
      return `Connecting to ${pc}...`
    case 'retrying':
    case 'grace':
      return `Link to ${pc} is down; retrying.${s.error ? ` ${s.error}` : ''}`
    default:
      return ''
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
