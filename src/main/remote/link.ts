// This machine as a remote machine: it dials out to its paired orchestrator over the local network
// (no port is opened here), serves its core over that link, and keeps its own window read-only
// while the orchestrator is connected. The person at this machine can always take it back with
// Disconnect. Projects can only be added from the shared folders, terminals need their own switch,
// and every action the orchestrator takes is written to the audit log.
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { createConnection as netConnection } from 'node:net'
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import { WebSocket } from 'ws'
import { ALPN_LINK, ALPN_PAIR, DEFAULT_PORT, LINK_METHODS, MAX_FILE_BYTES, MAX_FRAME_BYTES, PAIR_TTL_MS, PC_ONLY, PROTOCOL, REMOTE_TERM_PREFIX, type ByeReason, type Frame, type Hello } from '@shared/remote'
import type { FolderListing, LinkState, LoopDecision, LoopDraft, LoopFolder, MachineHealth, MainEvent, RemoteStatus } from '@shared/types'
import type { SymphonyCore } from '../core'
import { isMac, isViewable, isWindows, keepAwake, readHealth } from '../platform'
import { browse } from './mdns'
import { pairingCode, peerFingerprint, type Identity } from './identity'
import { LinkServer } from './server'
import { audit, saveSettings, type RemoteSettings } from './settings'
import { Wire } from './wire'

const MAX_BACKOFF_MS = 30_000
const NETWORK_POLL_MS = 5_000
const HEALTH_POLL_MS = 60_000
const TERM_FLUSH_MS = 30
/** Terminal output waits while this much is queued on the socket, so it cannot delay session events. */
const TERM_HIGH_WATER = 1024 * 1024

interface PairingState {
  wire: Wire
  id: string
  name: string
  host: string
  port: number
  code: string
  accepted: boolean
  peerAccepted: boolean
  timer: NodeJS.Timeout
}

export class RemoteLink {
  private server: LinkServer
  private wire: Wire | null = null
  private linkState: LinkState = 'off'
  private connecting = false
  private backoff = 1000
  private dialTimer: NodeJS.Timeout | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private pairing: PairingState | null = null
  private discovered: RemoteStatus['remote']['discovered'] = []
  private stopBrowsing: (() => void) | null = null
  private netSignature = ''
  private netTimer: NodeJS.Timeout | undefined
  private healthTimer: NodeJS.Timeout | undefined
  private health: MachineHealth | null = null
  private termBuffer = new Map<string, string>()
  private termTimer: NodeJS.Timeout | undefined
  private pausedTerms = new Set<string>()
  private identity: Identity | null = null
  /** Set when the app quits: nothing redials after that. */
  private stopped = false
  private name = ''
  private appVersion = ''
  error: string | undefined

  constructor(
    private core: SymphonyCore,
    private settings: RemoteSettings,
    private statusChanged: () => void
  ) {
    this.server = new LinkServer(
      (method, args) => this.execute(method, args),
      (f) => void this.wire?.send(f)
    )
    core.on((e) => this.forward(e))
  }

  start(identity: Identity | null, name: string, appVersion: string): void {
    this.identity = identity
    this.name = name
    this.appVersion = appVersion
    this.netTimer = setInterval(() => this.watchNetwork(), NETWORK_POLL_MS)
    if (this.settings.remoteMode && identity) this.activate()
    else this.setState(this.settings.remoteMode ? 'unpaired' : 'off')
  }

  async setEnabled(on: boolean, identity: Identity): Promise<void> {
    this.identity = identity
    this.settings.remoteMode = on
    saveSettings(this.settings)
    if (on) this.activate()
    else this.deactivate()
  }

  private activate(): void {
    this.stopBrowsing ??= browse((list) => this.onDiscovered(list))
    if (this.settings.orchestrator) this.dial()
    else this.setState('unpaired')
  }

  private deactivate(): void {
    this.stopBrowsing?.()
    this.stopBrowsing = null
    this.discovered = []
    this.cancelPairing()
    this.endLink('disconnect')
    this.setState('off')
  }

  /** Disconnect clicked here: editable at once, and the link stays off until turned back on. */
  disconnect(): void {
    if (this.wire || this.linkState === 'grace') audit('disconnected here')
    this.settings.remoteMode = false
    saveSettings(this.settings)
    this.deactivate()
  }

  /** Forget the paired orchestrator. */
  revoke(): void {
    if (!this.settings.orchestrator) return
    audit('orchestrator revoked here', this.settings.orchestrator.name)
    this.endLink('revoke')
    this.settings.orchestrator = null
    saveSettings(this.settings)
    this.setState(this.settings.remoteMode ? 'unpaired' : 'off')
  }

  shutdown(reason: ByeReason): void {
    this.stopped = true
    clearInterval(this.netTimer)
    clearInterval(this.healthTimer)
    clearTimeout(this.dialTimer)
    clearTimeout(this.graceTimer)
    clearTimeout(this.termTimer)
    this.cancelPairing()
    this.stopBrowsing?.()
    const w = this.wire
    this.wire = null
    w?.close(reason)
  }

  onSuspend(): void {
    const w = this.wire
    if (!w) return
    this.wire = null
    w.close('sleep')
    this.dropped()
  }

  onResume(): void {
    this.retryNow()
  }

  setSettings(patch: { graceSeconds?: number; sharedFolders?: string[]; terminals?: boolean }): void {
    if (this.core.control) throw new Error(`Controlled by ${this.core.control.by}`)
    if (patch.graceSeconds !== undefined) this.settings.graceSeconds = Math.max(0, Math.min(3600, Math.round(patch.graceSeconds)))
    if (patch.sharedFolders) this.settings.sharedFolders = [...new Set(patch.sharedFolders.map((f) => resolve(f)))]
    if (patch.terminals !== undefined) this.settings.terminals = patch.terminals
    saveSettings(this.settings)
    // A new hello tells the orchestrator about the terminal switch.
    if (patch.terminals !== undefined) this.wire?.send(this.hello())
    this.statusChanged()
  }

  status(): RemoteStatus['remote'] {
    const p = this.pairing
    return {
      enabled: this.settings.remoteMode,
      state: this.linkState,
      pc: this.settings.orchestrator,
      discovered: this.discovered,
      pairing: p ? { name: p.name, code: p.code, accepted: p.accepted, peerAccepted: p.peerAccepted } : null,
      error: this.error,
      graceSeconds: this.settings.graceSeconds,
      sharedFolders: this.settings.sharedFolders,
      terminals: this.settings.terminals
    }
  }

  // ---------- pairing ----------

  pair(address: string, identity: Identity): void {
    this.identity = identity
    if (!this.settings.remoteMode) throw new Error('Turn on remote mode first.')
    const { host, port } = parseAddress(address)
    this.cancelPairing()
    this.error = undefined
    let serverId = ''
    let pairing: PairingState | null = null
    const ws = this.open(host, port, ALPN_PAIR, (sock) => {
      serverId = peerFingerprint(sock) ?? ''
      return !!serverId
    })
    ws.once('error', (err) => {
      if (pairing) return
      this.error = `Could not reach ${host}:${port}: ${err.message}`
      this.setState(this.settings.orchestrator ? this.linkState : 'unpaired')
    })
    ws.once('open', () => {
      const wire: Wire = new Wire(
        ws,
        (f) => {
          if (f.t === 'hello' && !pairing) {
            pairing = { wire, id: serverId, name: f.machineName, host, port, code: pairingCode(identity.id, serverId), accepted: false, peerAccepted: false, timer: setTimeout(() => this.cancelPairing('The pairing code expired.'), PAIR_TTL_MS) }
            this.pairing = pairing
            this.setState('pairing')
          } else if (f.t === 'pairDecision' && pairing) {
            if (!f.accept) return this.cancelPairing(`${pairing.name} rejected the pairing.`)
            pairing.peerAccepted = true
            this.statusChanged()
          } else if (f.t === 'paired' && pairing?.accepted) {
            // The orchestrator pinned this machine; pin it back and link.
            this.settings.orchestrator = { id: pairing.id, name: pairing.name, host: pairing.host, port: pairing.port }
            saveSettings(this.settings)
            audit('paired', pairing.name)
            clearTimeout(pairing.timer)
            this.pairing = null
            wire.close()
            this.backoff = 1000
            this.dial()
          }
        },
        () => {
          if (this.pairing === pairing && pairing) this.cancelPairing('The pairing connection closed.')
        }
      )
      wire.send(this.hello())
    })
  }

  pairDecision(accept: boolean): void {
    const p = this.pairing
    if (!p) throw new Error('There is no pairing in progress.')
    if (!accept) {
      p.wire.send({ t: 'pairDecision', accept: false })
      return this.cancelPairing()
    }
    p.accepted = true
    p.wire.send({ t: 'pairDecision', accept: true })
    this.statusChanged()
  }

  private cancelPairing(error?: string): void {
    const p = this.pairing
    this.pairing = null
    if (error) this.error = error
    if (p) {
      clearTimeout(p.timer)
      p.wire.close()
      this.setState(this.settings.orchestrator ? (this.wire ? 'connected' : 'retrying') : this.settings.remoteMode ? 'unpaired' : 'off')
    }
  }

  // ---------- the link ----------

  private open(host: string, port: number, alpn: string, verify: (sock: TLSSocket) => boolean): WebSocket {
    const id = this.identity!
    return new WebSocket(`wss://${host}:${port}/`, {
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 10_000,
      createConnection: ((opts: ConnectionOptions) => {
        const sock = connect({ ...opts, key: id.key, cert: id.cert, rejectUnauthorized: false, ALPNProtocols: [alpn] })
        // The orchestrator's certificate is checked before anything is sent over the connection.
        sock.once('secureConnect', () => {
          if (!verify(sock)) sock.destroy(new Error('The orchestrator presented a different certificate.'))
        })
        return sock
      }) as unknown as typeof netConnection
    })
  }

  private dial(): void {
    clearTimeout(this.dialTimer)
    const pc = this.settings.orchestrator
    if (!pc || !this.settings.remoteMode || !this.identity || this.wire || this.connecting || this.stopped) return
    this.connecting = true
    if (this.linkState !== 'grace') this.setState('connecting')
    const ws = this.open(pc.host, pc.port, ALPN_LINK, (sock) => peerFingerprint(sock) === pc.id)
    let opened = false
    const failed = (err?: Error) => {
      if (opened) return
      opened = true
      this.connecting = false
      if (err) this.error = `Cannot reach ${pc.name} at ${pc.host}:${pc.port} (${err.message}).`
      if (this.linkState !== 'grace') this.setState('retrying')
      this.scheduleRetry()
    }
    ws.once('error', failed)
    ws.once('close', () => failed())
    ws.once('open', () => {
      opened = true
      this.connecting = false
      const wire: Wire = new Wire(
        ws,
        (f) => this.onFrame(wire, f),
        (bye) => this.onDrop(wire, bye)
      )
      this.wire = wire
      wire.send(this.hello())
    })
  }

  private onFrame(wire: Wire, f: Frame): void {
    if (wire !== this.wire) return
    switch (f.t) {
      case 'hello': {
        if (f.protocol !== PROTOCOL) {
          this.error = `${f.machineName} runs a different Symphony protocol. Update Symphony on both machines.`
          return this.endLink()
        }
        const pc = this.settings.orchestrator!
        if (pc.name !== f.machineName) {
          pc.name = f.machineName
          saveSettings(this.settings)
        }
        clearTimeout(this.graceTimer)
        this.backoff = 1000
        this.error = undefined
        if (this.linkState !== 'connected') audit('linked', pc.name)
        this.core.setUsagePolling(false)
        this.core.setControl({ by: pc.name, mode: 'connected' })
        this.setState('connected')
        this.server.snapshot(this.core.snapshot())
        void this.sendHealth(true)
        this.healthTimer ??= setInterval(() => void this.sendHealth(false), HEALTH_POLL_MS)
        break
      }
      case 'snapshotRequest':
        this.server.snapshot(this.core.snapshot())
        break
      case 'invoke':
        void this.server.invoke(f)
        break
      case 'refresh':
        this.core.refreshOnFocus()
        break
    }
  }

  private onDrop(wire: Wire, bye: ByeReason | null): void {
    if (wire !== this.wire) return
    this.wire = null
    if (bye === 'revoke') {
      audit('revoked by the orchestrator', this.settings.orchestrator?.name)
      this.settings.orchestrator = null
      saveSettings(this.settings)
      this.release()
      return this.setState('unpaired')
    }
    if (bye === 'quit' || bye === 'disconnect') {
      // Ended on purpose: editable at once, and the link redials on its own.
      this.release()
      this.setState('retrying')
      return this.scheduleRetry()
    }
    this.dropped()
  }

  /** The link dropped without a goodbye: stay read-only for the grace period while redialing. */
  private dropped(): void {
    const pc = this.settings.orchestrator
    const grace = this.settings.graceSeconds * 1000
    if (!pc || grace <= 0 || !this.core.control) {
      this.release()
      this.setState('retrying')
    } else {
      clearTimeout(this.graceTimer)
      const graceEndsAt = Date.now() + grace
      this.core.setControl({ by: pc.name, mode: 'grace', graceEndsAt })
      this.graceTimer = setTimeout(() => {
        this.release()
        this.setState('retrying')
      }, grace)
      this.setState('grace')
    }
    this.backoff = 1000
    this.scheduleRetry()
  }

  /** The window is this machine's own again. */
  private release(): void {
    clearTimeout(this.graceTimer)
    clearInterval(this.healthTimer)
    this.healthTimer = undefined
    this.core.setControl(null)
    this.core.setUsagePolling(true)
    this.flushTerms(true)
  }

  private endLink(reason?: ByeReason): void {
    clearTimeout(this.dialTimer)
    const w = this.wire
    this.wire = null
    w?.close(reason)
    this.release()
  }

  private scheduleRetry(): void {
    clearTimeout(this.dialTimer)
    if (!this.settings.remoteMode || !this.settings.orchestrator || this.stopped) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.dialTimer = setTimeout(() => this.dial(), delay)
  }

  private retryNow(): void {
    if (this.wire || !this.settings.remoteMode || !this.settings.orchestrator) return
    this.backoff = 1000
    this.dial()
  }

  /** Redial at once when the network changes (Wi-Fi switched, address renewed). */
  private watchNetwork(): void {
    const sig = JSON.stringify(Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a!.address).sort())
    if (sig === this.netSignature) return
    const first = !this.netSignature
    this.netSignature = sig
    if (!first) this.retryNow()
  }

  private onDiscovered(list: RemoteStatus['remote']['discovered']): void {
    this.discovered = list
    // The orchestrator's address can change (DHCP); follow it by its certificate fingerprint.
    const pc = this.settings.orchestrator
    const found = pc && list.find((d) => d.id === pc.id)
    if (pc && found && (found.host !== pc.host || found.port !== pc.port)) {
      Object.assign(pc, { host: found.host, port: found.port })
      saveSettings(this.settings)
      this.retryNow()
    }
    this.statusChanged()
  }

  private setState(s: LinkState): void {
    this.linkState = s
    this.statusChanged()
  }

  private hello(): Frame {
    const h: Hello = { protocol: PROTOCOL, appVersion: this.appVersion, machineId: this.identity!.id, machineName: this.name, platform: process.platform, capabilities: { terminals: this.settings.terminals } }
    return { t: 'hello', ...h }
  }

  private async sendHealth(force: boolean): Promise<void> {
    const h = await readHealth().catch(() => null)
    if (!h || !this.wire) return
    const prev = this.health
    const step = (x: MachineHealth | null) => (x?.battery === null || x?.battery === undefined ? -1 : Math.floor(x.battery / 5))
    if (force || !prev || prev.charging !== h.charging || prev.lowPower !== h.lowPower || step(prev) !== step(h)) {
      this.health = h
      this.wire.send({ t: 'health', health: h })
    }
  }

  /** Power events between battery and mains. */
  onPowerChange(): void {
    void this.sendHealth(false)
  }

  // ---------- events to the orchestrator ----------

  private forward(e: MainEvent): void {
    if (e.type === 'session' || e.type === 'loop') keepAwake(this.settings.remoteMode && this.core.busy())
    if (!this.wire || this.linkState !== 'connected') return
    switch (e.type) {
      case 'usage':
      case 'control':
      case 'machine':
      case 'machineRemoved':
      case 'remote':
      case 'snapshot':
        return
      case 'term':
        // The orchestrator only sees its own terminals, batched.
        if (!e.id.startsWith(REMOTE_TERM_PREFIX)) return
        this.termBuffer.set(e.id, (this.termBuffer.get(e.id) ?? '') + e.data)
        this.termTimer ??= setTimeout(() => this.flushTerms(false), TERM_FLUSH_MS)
        return
      case 'termExit':
        if (!e.id.startsWith(REMOTE_TERM_PREFIX)) return
        this.flushTerm(e.id)
        this.server.event({ ...e, id: e.id.slice(REMOTE_TERM_PREFIX.length) })
        return
      default:
        this.server.event(e)
    }
  }

  private flushTerms(all: boolean): void {
    this.termTimer = undefined
    if (!this.wire) {
      this.termBuffer.clear()
      for (const id of this.pausedTerms) this.core.terminals.resume(id)
      this.pausedTerms.clear()
      return
    }
    if (!all && this.wire.buffered > TERM_HIGH_WATER) {
      // Hold terminal output until the socket drains, so session events are not delayed behind it.
      for (const id of this.termBuffer.keys()) if (!this.pausedTerms.has(id)) (this.pausedTerms.add(id), this.core.terminals.pause(id))
      this.termTimer = setTimeout(() => this.flushTerms(false), TERM_FLUSH_MS * 4)
      return
    }
    for (const id of [...this.termBuffer.keys()]) this.flushTerm(id)
    for (const id of this.pausedTerms) this.core.terminals.resume(id)
    this.pausedTerms.clear()
  }

  private flushTerm(id: string): void {
    const data = this.termBuffer.get(id)
    this.termBuffer.delete(id)
    if (data) this.server.event({ type: 'term', id: id.slice(REMOTE_TERM_PREFIX.length), data })
  }

  // ---------- requests from the orchestrator ----------

  private async execute(method: string, args: unknown[]): Promise<unknown> {
    // asset/openAsset are served by the orchestrator from its own copy, fetched with fetchAsset.
    if (PC_ONLY.has(method) || method.startsWith('remote') || method === 'claudeLogin' || method === 'asset' || method === 'openAsset' || method === 'loopOpenFile') throw new Error(`${method} is not available remotely`)
    if (LINK_METHODS.has(method)) {
      if (method === 'listFolders') return this.listFolders(args[0] as string | undefined)
      if (method === 'fetchAsset') return this.fetchAsset(String(args[0]))
      return this.fetchLoopFile(String(args[0]), String(args[1]), String(args[2]))
    }
    const term = (id: unknown) => `${REMOTE_TERM_PREFIX}${String(id)}`
    switch (method) {
      case 'addProject': {
        if (typeof args[0] !== 'string') throw new Error('Pick a folder from the shared folders.')
        const path = await this.insideShared(args[0])
        audit('project added', path)
        return this.core.invoke('addProject', [path])
      }
      case 'termStart':
        if (!this.settings.terminals) throw new Error(`Terminals are switched off on ${this.name}.`)
        audit('terminal opened', args[1] ? this.projectName(args[1] as string) : 'home folder')
        return this.core.invoke('termStart', [term(args[0]), ...args.slice(1, 4)])
      case 'termWrite':
        if (!this.settings.terminals) throw new Error(`Terminals are switched off on ${this.name}.`)
        return this.core.invoke(method, [term(args[0]), ...args.slice(1)])
      case 'termResize':
      case 'termKill':
        return this.core.invoke(method, [term(args[0]), ...args.slice(1)])
      case 'loopCreate':
      case 'loopUpdate':
        await this.checkLoopFolders((args[method === 'loopCreate' ? 0 : 1] as LoopDraft).folders)
        break
      case 'loopStart':
        await this.checkLoopFolders(this.core.loops.list().find((l) => l.id === args[0])?.folders ?? [])
        break
    }
    this.auditRequest(method, args)
    return this.core.invoke(method, args)
  }

  private auditRequest(method: string, args: unknown[]): void {
    const first = (v: unknown) => String(v ?? '').split('\n')[0].slice(0, 120)
    const session = (id: unknown) => this.core.sessions.get(String(id))?.title.split('\n')[0].slice(0, 80) ?? String(id)
    const loop = (id: unknown) => this.core.loops.list().find((l) => l.id === id)?.name ?? String(id)
    switch (method) {
      case 'startPipeline':
        return audit('session started', `${this.projectName(args[0] as string)}: ${first(args[1])}`)
      case 'startConfigSession':
        return audit('config session started', `${args[0]}: ${first(args[1])}`)
      case 'sendMessage':
        return audit('message sent', `${session(args[0])}: ${first(args[1])}`)
      case 'respondApproval':
        return audit('approval answered', `${args[2]} in ${session(args[0])}`)
      case 'respondQuestion':
        return audit('question answered', session(args[0]))
      case 'stopSession':
        return audit('session stopped', session(args[0]))
      case 'dismissSession':
        return audit('session removed', session(args[0]))
      case 'setAutoApprove':
        return audit(`auto-approve turned ${args[0] ? 'on' : 'off'}`)
      case 'gitSwitch':
        return audit(`switched to ${first(args[1])}`, this.projectName(args[0] as string))
      case 'gitCommit':
        return audit('committed', `${this.projectName(args[0] as string)}: ${first(args[1])}`)
      case 'referenceAdd':
        return audit('reference added', `${this.projectName(args[0] as string)}: ${first(args[1])}`)
      case 'referenceDelete':
        return audit('reference deleted', `${this.projectName(args[0] as string)}: ${first(args[1])}`)
      case 'writeClaudeMd':
        return audit('CLAUDE.md saved', this.projectName(args[0] as string))
      case 'removeProject':
        return audit('project removed', this.projectName(args[0] as string))
      case 'loopCreate':
        return audit('loop created', (args[0] as LoopDraft).name)
      case 'loopUpdate':
      case 'loopDelete':
      case 'loopStart':
      case 'loopStop':
        return audit(`loop ${method.slice(4).toLowerCase()}`, loop(args[0]))
      case 'loopDecide':
        return audit(`loop decision: ${(args[1] as LoopDecision).decision}`, loop(args[0]))
      case 'ghLogin':
        return audit('GitHub sign-in started')
    }
  }

  private projectName(id: string): string {
    return this.core.state.projects.find((p) => p.id === id)?.name ?? id
  }

  /** A path inside one of the shared folders, resolved here; anything else is refused. */
  private async insideShared(path: string): Promise<string> {
    const real = await realpath(resolve(path)).catch(() => {
      throw new Error(`${path} does not exist on ${this.name}.`)
    })
    for (const folder of this.settings.sharedFolders) {
      const root = await realpath(folder).catch(() => null)
      if (root && isInside(real, root)) return real
    }
    throw new Error(`${path} is not inside a folder ${this.name} shares.`)
  }

  private async listFolders(path?: string): Promise<FolderListing> {
    const hasGit = (p: string) => existsSync(join(p, '.git'))
    if (!path) {
      return { path: null, parent: null, entries: this.settings.sharedFolders.map((f) => ({ name: f, path: f, git: hasGit(f) })) }
    }
    const real = await this.insideShared(path)
    const roots = await Promise.all(this.settings.sharedFolders.map((f) => realpath(f).catch(() => null)))
    const isRoot = roots.some((r) => r && samePathCase(r, real))
    const entries = (await readdir(real, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: join(real, d.name), git: hasGit(join(real, d.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { path: real, parent: isRoot ? null : dirname(real), entries }
  }

  /** A loop may only use folders this machine shares; its temporary folders are its own. */
  private async checkLoopFolders(folders: LoopFolder[]): Promise<void> {
    for (const f of folders) if (f.path && !f.parentId) await this.insideShared(f.path)
  }

  /** A stored file (shown in a session), by its content hash. */
  private async fetchAsset(id: string): Promise<{ data: string; ext: string }> {
    const { data, ext } = await this.core.assets.read(id)
    return { data: data.toString('base64'), ext }
  }

  /** A file from a loop folder, sent to the orchestrator to open there. Viewable types only. */
  private async fetchLoopFile(id: string, folderId: string, rel: string): Promise<{ name: string; data: string } | { error: string }> {
    const path = this.core.loops.filePath(id, folderId, rel)
    if (!existsSync(path)) return { error: `${path} does not exist on ${this.name}.` }
    if (!isViewable(path)) return { error: `Only documents and images can be opened from ${this.name}; this file stays there (${path}).` }
    const info = await stat(path)
    if (info.size > MAX_FILE_BYTES) return { error: `${basename(path)} is too large to send (${Math.round(info.size / 1024 / 1024)} MB).` }
    audit('loop file opened remotely', path)
    return { name: basename(path), data: (await readFile(path)).toString('base64') }
  }
}

function parseAddress(address: string): { host: string; port: number } {
  const m = /^\s*([^:\s]+)(?::(\d+))?\s*$/.exec(address)
  if (!m) throw new Error('Enter an address like 192.168.1.20 or 192.168.1.20:47821.')
  return { host: m[1], port: m[2] ? Number(m[2]) : DEFAULT_PORT }
}

/** macOS and Windows volumes are usually case-insensitive. */
function samePathCase(a: string, b: string): boolean {
  return isWindows || isMac ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(child: string, parent: string): boolean {
  const sep = isWindows ? '\\' : '/'
  const p = parent.endsWith(sep) ? parent : parent + sep
  return samePathCase(child, parent) || (isWindows || isMac ? child.toLowerCase().startsWith(p.toLowerCase()) : child.startsWith(p))
}
