// This machine as orchestrator. It listens on its local-network addresses (TLS, both certificates
// pinned), pairs new machines by comparing a 6-digit code, keeps one link and one mirror per
// remote machine, merges their state with its own, and routes every request to the machine that
// owns its target. What it knows about each machine is saved, so after a restart every paired
// machine appears at once, offline, with its last known state.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { networkInterfaces, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ALPN_LINK,
  ALPN_PAIR,
  LOCAL_MACHINE_NODE,
  MACHINE_ARG,
  machineNodeId,
  MAX_FRAME_BYTES,
  NO_TIMEOUT,
  PAIR_TTL_MS,
  PC_ONLY,
  PROTOCOL,
  READ_METHODS,
  REFRESH_MIN_MS,
  REQUEST_TIMEOUT_MS,
  RESEND_GRACE_MS,
  splitMachine,
  type ByeReason,
  type Frame,
  type Hello
} from '@shared/remote'
import type { AppSnapshot, AssetRef, GitStats, LoopArtifact, LoopInfo, MachineHealth, MachineState, MachineStatus, MainEvent, Point, Project, RemoteStatus, TranscriptItem } from '@shared/types'
import type { SymphonyCore } from '../core'
import type { Adapters } from '../platform'
import { deleteJson, listJson, loadJson, saveJson } from '../store'
import { advertise } from './mdns'
import { MachineMirror, type SavedMirror } from './mirror'
import { pairingCode, peerFingerprint, type Identity } from './identity'
import { saveSettings, type RemoteSettings } from './settings'
import { Wire } from './wire'

const PAIRINGS_PER_MINUTE = 5
const HELLO_TIMEOUT_MS = 15_000
const ADDRESS_POLL_MS = 30_000

interface Pending {
  id: string
  method: string
  args: unknown[]
  resolve(v: unknown): void
  reject(e: Error): void
  timer?: NodeJS.Timeout
  /** Waiting for a resend after the link dropped. */
  held: boolean
}

interface Machine {
  id: string
  name: string
  platform: string
  appVersion: string
  outdated: boolean
  status: MachineStatus
  since: number
  lastSeen: number
  health?: MachineHealth
  terminals: boolean
  mirror: MachineMirror
  wire: Wire | null
  pending: Map<string, Pending>
  lastRefresh: number
  /** The last GitHub sign-in page opened for this machine, so it opens once. */
  loginUrl?: string
}

interface Pairing {
  id: string
  hello: Hello
  code: string
  wire: Wire
  accepted: boolean
  peerAccepted: boolean
  timer: NodeJS.Timeout
}

interface SavedMachine extends SavedMirror {
  name: string
  platform: string
  appVersion: string
  lastSeen: number
}

const remoteFile = (id: string) => `remotes/${id}.json`
const FILE_OWNERS = 'remote-files.json'

export class Orchestrator {
  /** How long a pairing code stays valid (tests shorten it). */
  static pairTtlMs = PAIR_TTL_MS
  private machines = new Map<string, Machine>()
  private pairings = new Map<string, Pairing>()
  private servers = new Map<string, Server>()
  private sockets = new WeakMap<TLSSocket, { id: string; mode: 'link' | 'pair' }>()
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  private stopAdvertising: (() => void) | null = null
  private addressTimer: NodeJS.Timeout | undefined
  private pairTimes: number[] = []
  private identity: Identity | null = null
  /** Files being fetched from remote machines, by asset id, so each is fetched once. */
  private fetching = new Map<string, Promise<string>>()
  /**
   * Which remote sessions and loops each copied file belongs to ("machineId/ownerId"). A copy is
   * deleted once none of them exist any more.
   */
  private fileOwners: Record<string, string[]> = {}
  private name = ''
  private appVersion = ''
  error: string | undefined

  constructor(
    private core: SymphonyCore,
    private settings: RemoteSettings,
    private adapters: Adapters,
    /** Events for this machine's window (already transformed). */
    private emit: (e: MainEvent) => void,
    /** The remote-orchestration panel's status changed. */
    private statusChanged: () => void
  ) {}

  /** Bring back every paired machine, offline, with its last known state. */
  load(): void {
    this.fileOwners = loadJson<Record<string, string[]>>(FILE_OWNERS, {})
    this.core.extraFileRefs = () => Object.keys(this.fileOwners)
    for (const p of this.settings.machines) {
      const saved = loadJson<SavedMachine | null>(remoteFile(p.id), null)
      const m = this.add(p.id, saved?.name ?? p.name, saved?.platform ?? p.platform)
      m.appVersion = saved?.appVersion ?? ''
      m.lastSeen = saved?.lastSeen ?? p.pairedAt
      m.since = m.lastSeen
      if (saved) m.mirror.restore(saved)
    }
    // Files of machines that were revoked while the app was closed.
    for (const id of listJson('remotes')) if (!this.machines.has(id)) deleteJson(remoteFile(id))
  }

  start(identity: Identity | null, name: string, appVersion: string): void {
    this.identity = identity
    this.name = name
    this.appVersion = appVersion
    if (this.settings.orchestrate && identity) this.listen()
  }

  async setEnabled(on: boolean, identity: Identity, name: string): Promise<void> {
    this.identity = identity
    this.name = name
    this.settings.orchestrate = on
    saveSettings(this.settings)
    if (on) this.listen()
    else this.stop('disconnect')
    this.statusChanged()
  }

  /** End every link (saying why), stop listening and advertising. */
  stop(reason: ByeReason): void {
    clearInterval(this.addressTimer)
    this.addressTimer = undefined
    for (const m of this.machines.values()) m.wire?.close(reason)
    for (const p of [...this.pairings.values()]) this.endPairing(p)
    for (const s of this.servers.values()) s.close()
    this.servers.clear()
    this.stopAdvertising?.()
    this.stopAdvertising = null
  }

  setPort(port: number): void {
    if (this.settings.port === port) return
    this.settings.port = port
    saveSettings(this.settings)
    if (!this.settings.orchestrate) return
    for (const s of this.servers.values()) s.close()
    this.servers.clear()
    this.stopAdvertising?.()
    this.stopAdvertising = null
    this.listen()
  }

  // ---------- listening ----------

  private listen(): void {
    this.error = undefined
    this.syncServers()
    this.addressTimer ??= setInterval(() => this.syncServers(), ADDRESS_POLL_MS)
    if (!this.stopAdvertising && this.identity) this.stopAdvertising = advertise({ id: this.identity.id, name: this.name, port: this.settings.port })
  }

  /** One server per local-network address (never a public one), following address changes. */
  private syncServers(): void {
    const wanted = lanAddresses()
    for (const [addr, server] of this.servers) {
      if (wanted.includes(addr)) continue
      server.close()
      this.servers.delete(addr)
    }
    for (const addr of wanted) if (!this.servers.has(addr)) this.serve(addr)
    this.statusChanged()
  }

  private serve(address: string): void {
    const id = this.identity!
    const server = createServer({ key: id.key, cert: id.cert, requestCert: true, rejectUnauthorized: false, ALPNProtocols: [ALPN_LINK, ALPN_PAIR] })
    // Decided right after the TLS handshake, before any request is read: a link needs a pinned
    // certificate, and anything else may only ask to pair (rate-limited).
    server.on('secureConnection', (sock: TLSSocket) => {
      const fp = peerFingerprint(sock)
      if (fp && sock.alpnProtocol === ALPN_LINK && this.settings.machines.some((m) => m.id === fp)) return void this.sockets.set(sock, { id: fp, mode: 'link' })
      if (fp && sock.alpnProtocol === ALPN_PAIR && this.allowPairing()) return void this.sockets.set(sock, { id: fp, mode: 'pair' })
      sock.destroy()
    })
    server.on('upgrade', (req, socket, head) => {
      const info = this.sockets.get(req.socket as TLSSocket)
      if (!info) return void socket.destroy()
      this.wss.handleUpgrade(req, socket, head, (ws) => (info.mode === 'link' ? this.onLink(info.id, ws) : this.onPair(info.id, ws)))
    })
    server.on('request', (_req, res) => {
      res.statusCode = 426
      res.end()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.error = err.code === 'EADDRINUSE' ? `Port ${this.settings.port} is already in use on ${address}.` : err.message
      this.servers.delete(address)
      this.statusChanged()
    })
    server.listen(this.settings.port, address)
    this.servers.set(address, server)
  }

  private allowPairing(): boolean {
    const now = Date.now()
    this.pairTimes = this.pairTimes.filter((t) => now - t < 60_000)
    if (this.pairTimes.length >= PAIRINGS_PER_MINUTE) return false
    this.pairTimes.push(now)
    return true
  }

  // ---------- pairing ----------

  private onPair(id: string, ws: WebSocket): void {
    let pairing: Pairing | null = null
    const wire = new Wire(
      ws,
      (f) => {
        if (f.t === 'hello' && !pairing) {
          if (f.protocol !== PROTOCOL) return void wire.close()
          const older = this.pairings.get(id)
          if (older) this.endPairing(older)
          pairing = { id, hello: f, code: pairingCode(this.identity!.id, id), wire, accepted: false, peerAccepted: false, timer: setTimeout(() => pairing && this.endPairing(pairing), Orchestrator.pairTtlMs) }
          this.pairings.set(id, pairing)
          wire.send(this.hello())
          this.emit({ type: 'machine', machine: this.pairingState(pairing) })
          this.statusChanged()
        } else if (f.t === 'pairDecision' && pairing) {
          if (!f.accept) return this.endPairing(pairing)
          pairing.peerAccepted = true
          this.completePairing(pairing)
          this.statusChanged()
        }
      },
      () => {
        if (pairing && this.pairings.get(id) === pairing) this.endPairing(pairing)
      }
    )
    setTimeout(() => !pairing && wire.close(), HELLO_TIMEOUT_MS)
  }

  pairDecision(id: string, accept: boolean): void {
    const p = this.pairings.get(id)
    if (!p) throw new Error('This pairing request expired. Start it again on the other machine.')
    if (!accept) return this.endPairing(p, true)
    p.accepted = true
    p.wire.send({ t: 'pairDecision', accept: true })
    this.completePairing(p)
    this.statusChanged()
  }

  /** Both sides accepted: pin the machine, tell it, and let it link. */
  private completePairing(p: Pairing): void {
    if (!p.accepted || !p.peerAccepted) return
    clearTimeout(p.timer)
    this.pairings.delete(p.id)
    const others = this.settings.machines.filter((m) => m.id !== p.id)
    this.settings.machines = [...others, { id: p.id, name: p.hello.machineName, platform: p.hello.platform, pairedAt: Date.now() }]
    saveSettings(this.settings)
    const m = this.machines.get(p.id) ?? this.add(p.id, p.hello.machineName, p.hello.platform)
    m.name = p.hello.machineName
    m.appVersion = p.hello.appVersion
    m.since = Date.now()
    this.layout(p.id)[machineNodeId(p.id)] ??= this.newMachinePosition(p.id)
    this.core.persist()
    p.wire.send({ t: 'paired' })
    setTimeout(() => p.wire.close(), 1000)
    this.emit({ type: 'machine', machine: this.state(m) })
    this.statusChanged()
  }

  private endPairing(p: Pairing, tell = false): void {
    clearTimeout(p.timer)
    if (this.pairings.get(p.id) === p) this.pairings.delete(p.id)
    if (tell) p.wire.send({ t: 'pairDecision', accept: false })
    p.wire.close()
    const known = this.machines.get(p.id)
    this.emit(known ? { type: 'machine', machine: this.state(known) } : { type: 'machineRemoved', id: p.id })
    this.statusChanged()
  }

  // ---------- links ----------

  private onLink(id: string, ws: WebSocket): void {
    const m = this.machines.get(id)
    if (!m) return void ws.close()
    // A new link replaces an older one that has not noticed it is dead yet.
    const old = m.wire
    m.wire = null
    old?.close()
    let helloed = false
    const wire: Wire = new Wire(
      ws,
      (f) => {
        m.lastSeen = Date.now()
        if (f.t === 'hello') {
          helloed = true
          this.onHello(m, wire, f)
        } else if (helloed) this.onFrame(m, f)
      },
      (bye) => this.onDrop(m, wire, bye)
    )
    m.wire = wire
    setTimeout(() => !helloed && wire.close(), HELLO_TIMEOUT_MS)
  }

  private onHello(m: Machine, wire: Wire, h: Hello): void {
    m.name = h.machineName
    m.platform = h.platform
    m.appVersion = h.appVersion
    m.terminals = h.capabilities.terminals
    if (h.protocol !== PROTOCOL) {
      // Different protocol: nothing can be exchanged. The node asks for an update.
      m.outdated = true
      this.setStatus(m, 'offline')
      return wire.close()
    }
    m.outdated = h.appVersion !== this.appVersion
    const saved = this.settings.machines.find((x) => x.id === m.id)
    if (saved && (saved.name !== h.machineName || saved.platform !== h.platform)) {
      Object.assign(saved, { name: h.machineName, platform: h.platform })
      saveSettings(this.settings)
    }
    wire.send(this.hello())
    m.mirror.beginSync()
    this.setStatus(m, 'reconnecting')
  }

  private onFrame(m: Machine, f: Frame): void {
    switch (f.t) {
      case 'snapshot': {
        m.mirror.onSnapshot(f.snapshot, f.seq)
        for (const l of f.snapshot.loops) this.prefetch(m, waitingFiles(l), l.id)
        // Sessions and loops deleted while the link was down: their copies go too.
        const alive = new Set([...f.snapshot.sessions.map((x) => x.id), ...f.snapshot.loops.map((l) => l.id)])
        this.dropOwners(m.id, (owner) => !alive.has(owner))
        if (m.status !== 'online') {
          this.setStatus(m, 'online')
          this.resend(m)
        }
        // Nothing stale remains: the window reloads the merged state.
        this.emit({ type: 'snapshot', snapshot: this.snapshot() })
        break
      }
      case 'event':
        m.mirror.onEvent(f.seq, f.event)
        break
      case 'result':
        this.onResult(m, f)
        break
      case 'health':
        m.health = f.health
        this.emit({ type: 'machine', machine: this.state(m) })
        break
    }
  }

  private onDrop(m: Machine, wire: Wire, bye: ByeReason | null): void {
    if (m.wire !== wire) return
    m.wire = null
    // The machine forgot this orchestrator; forget it here too.
    if (bye === 'revoke') return this.revoke(m.id)
    m.lastSeen = Date.now()
    this.setStatus(m, bye === 'sleep' ? 'asleep' : bye === 'quit' ? 'quit' : 'offline')
    for (const p of [...m.pending.values()]) {
      clearTimeout(p.timer)
      // Reads are fetched again after the resync rather than resent.
      if (READ_METHODS.has(p.method)) {
        m.pending.delete(p.id)
        p.reject(new Error(`${m.name} went offline`))
        continue
      }
      p.held = true
      p.timer = setTimeout(() => {
        m.pending.delete(p.id)
        p.reject(new Error(`${m.name} went offline`))
      }, RESEND_GRACE_MS)
    }
    this.save(m)
  }

  /** After a resync, send the requests the drop interrupted again, with the same ids (they run once). */
  private resend(m: Machine): void {
    for (const p of m.pending.values()) {
      if (!p.held) continue
      clearTimeout(p.timer)
      p.held = false
      this.transmit(m, p)
    }
  }

  private setStatus(m: Machine, status: MachineStatus): void {
    if (m.status !== status) {
      m.status = status
      m.since = Date.now()
    }
    this.emit({ type: 'machine', machine: this.state(m) })
    this.save(m)
    this.statusChanged()
  }

  private hello(): Frame {
    return { t: 'hello', protocol: PROTOCOL, appVersion: this.appVersion, machineId: this.identity!.id, machineName: this.name, platform: process.platform, capabilities: { terminals: false } }
  }

  // ---------- requests ----------

  /** A request from this machine's window: run it here, or send it to the machine that owns its target. */
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'snapshot') return this.snapshot()
    if (method === 'moveNode') return this.moveNode(args[0] as string, args[1] as Point)
    if (PC_ONLY.has(method)) return this.core.invokeLocal(method, args)
    if (method === 'remoteBrowse') return this.request(this.need(args[0] as string), 'listFolders', args[1] === undefined ? [] : [args[1]])
    if (method === 'refreshConfig' && !args[0]) {
      const online = [...this.machines.values()].filter((m) => m.status === 'online')
      await Promise.all([this.core.invokeLocal('refreshConfig', []), ...online.map((m) => this.request(m, 'refreshConfig', []).catch(() => undefined))])
      return
    }
    const owner = this.ownerOf(method, args)
    const idx = MACHINE_ARG[method]
    const plain = idx === undefined ? args : args.slice(0, idx)
    if (!owner) return this.core.invokeLocal(method, plain)
    const m = this.need(owner)
    const forwarded = plain.map((a) => (typeof a === 'string' ? (splitMachine(a)?.machineId === owner ? splitMachine(a)!.id : a) : a))
    if (method === 'openArtifact') return this.openRemoteArtifact(m, forwarded[0] as string, forwarded[1] as LoopArtifact)
    if (method === 'asset' || method === 'openAsset') {
      // Served from this machine's copy, so a file fetched once can still be seen while its machine is offline.
      const path = await this.ensureAsset(m, String(forwarded[1]), String(forwarded[0]))
      return method === 'openAsset' ? this.adapters.openPath(path) : this.core.assets.dataUrl(String(forwarded[1]))
    }
    if (m.status !== 'online' && m.status !== 'reconnecting') return this.offlineRead(m, method, forwarded)
    const value = await this.request(m, method, forwarded)
    return this.decorateResult(m, method, forwarded, value)
  }

  /** The machine that owns a request's target, or null for this one. */
  ownerOf(method: string, args: unknown[]): string | null {
    const idx = MACHINE_ARG[method]
    if (idx !== undefined && typeof args[idx] === 'string' && args[idx] !== 'local') return args[idx] as string
    for (const a of args) {
      if (typeof a !== 'string') continue
      const split = splitMachine(a)
      if (split && this.machines.has(split.machineId)) return split.machineId
      for (const m of this.machines.values()) if (m.mirror.owns(a)) return m.id
    }
    return null
  }

  private need(id: string): Machine {
    const m = this.machines.get(id)
    if (!m) throw new Error('Unknown machine')
    return m
  }

  private request(m: Machine, method: string, args: unknown[]): Promise<unknown> {
    if (!m.wire) return Promise.reject(new Error(`${m.name} is offline`))
    return new Promise((resolve, reject) => {
      const p: Pending = { id: randomUUID(), method, args, resolve, reject, held: false }
      m.pending.set(p.id, p)
      this.transmit(m, p)
    })
  }

  private transmit(m: Machine, p: Pending): void {
    if (!m.wire?.send({ t: 'invoke', id: p.id, method: p.method, args: p.args })) {
      m.pending.delete(p.id)
      return p.reject(new Error(m.wire ? 'The request is too large to send.' : `${m.name} is offline`))
    }
    if (NO_TIMEOUT.has(p.method)) return
    p.timer = setTimeout(() => {
      m.pending.delete(p.id)
      p.reject(new Error(`No answer from ${m.name}`))
    }, REQUEST_TIMEOUT_MS)
  }

  private onResult(m: Machine, f: Extract<Frame, { t: 'result' }>): void {
    const p = m.pending.get(f.id)
    if (!p) return
    m.pending.delete(f.id)
    clearTimeout(p.timer)
    if (!f.ok) return p.reject(new Error(f.error ?? 'Failed'))
    if (p.method === 'transcript') m.mirror.onTranscript(p.args[0] as string, f.value as TranscriptItem[], f.seq ?? m.mirror.seq)
    p.resolve(f.value)
  }

  private decorateResult(m: Machine, method: string, args: unknown[], value: unknown): unknown {
    const snap = m.mirror.snapshot
    switch (method) {
      case 'addProject':
        return value ? m.mirror.project(value as Project) : value
      case 'loopCreate':
      case 'loopUpdate':
        return m.mirror.loop(value as LoopInfo)
      case 'respondApproval':
      case 'respondQuestion':
        // The other side answered first: the first answer wins, and this is not an error.
        return value ? `Already answered on ${m.name}.` : null
      case 'setDefaultModel':
      case 'setModelEffort':
        // The remote core does not announce these; keep the mirror in step.
        if (snap && method === 'setDefaultModel') snap.defaultModel = args[0] as string
        if (snap && method === 'setModelEffort') {
          if (args[1]) snap.efforts[args[0] as string] = args[1] as never
          else delete snap.efforts[args[0] as string]
        }
        this.emit({ type: 'machine', machine: this.state(m) })
        this.save(m)
        return value
      default:
        return value
    }
  }

  /** What can still be shown for an offline machine: its last known state. */
  private offlineRead(m: Machine, method: string, args: unknown[]): unknown {
    if (method === 'transcript') return m.mirror.cachedTranscript(args[0] as string) ?? []
    if (method === 'gitStats') return (m.mirror.snapshot?.git[args[0] as string] ?? { isRepo: true, added: 0, removed: 0, files: [] }) satisfies GitStats
    throw new Error(`${m.name} is offline`)
  }

  /** This machine's copy of a remote file: fetched once, checked against its hash, kept in the asset store. */
  private ensureAsset(m: Machine, id: string, ownerId: string): Promise<string> {
    const owner = `${m.id}/${ownerId}`
    const owners = (this.fileOwners[id] ??= [])
    if (!owners.includes(owner)) {
      owners.push(owner)
      saveJson(FILE_OWNERS, () => this.fileOwners, 1000)
    }
    const have = this.core.assets.path(id)
    if (have) return Promise.resolve(have)
    if (m.status !== 'online' && m.status !== 'reconnecting') return Promise.reject(new Error(`${m.name} is offline, and this file was not fetched before it went.`))
    let p = this.fetching.get(id)
    if (!p) {
      p = this.request(m, 'fetchAsset', [id])
        .then((r) => {
          const { data, ext } = r as { data: string; ext: string }
          return this.core.assets.putVerified(id, ext, Buffer.from(data, 'base64'))
        })
        .finally(() => this.fetching.delete(id))
      this.fetching.set(id, p)
    }
    return p
  }

  /** Fetch shown and handed-over files as soon as they appear, so they can be reviewed even if the machine sleeps. */
  private prefetch(m: Machine, files: AssetRef[], ownerId: string): void {
    for (const f of files) void this.ensureAsset(m, f.id, ownerId).catch(() => undefined)
  }

  /** Forget the owners of copied files that `gone` matches; copies left without an owner are deleted. */
  private dropOwners(machineId: string, gone: (ownerId: string) => boolean): void {
    const freed: string[] = []
    let changed = false
    for (const [id, owners] of Object.entries(this.fileOwners)) {
      const keep = owners.filter((o) => !(o.startsWith(`${machineId}/`) && gone(o.slice(machineId.length + 1))))
      if (keep.length === owners.length) continue
      changed = true
      if (keep.length) this.fileOwners[id] = keep
      else {
        delete this.fileOwners[id]
        freed.push(id)
      }
    }
    if (!changed) return
    saveJson(FILE_OWNERS, () => this.fileOwners, 1000)
    this.core.releaseFiles(freed)
  }

  /** Files come over the link and open here (viewable types only); links to the machine itself cannot. */
  private async openRemoteArtifact(m: Machine, projectId: string, artifact: LoopArtifact): Promise<string | null> {
    if (artifact.url && !/^file:/i.test(artifact.url)) {
      let host = ''
      try {
        host = new URL(artifact.url).hostname
      } catch {
        return 'This link cannot be opened.'
      }
      if (/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(host)) return `This link points to ${m.name} itself (${host}), so it cannot open on this machine.`
      if (!/^https?:/i.test(artifact.url)) return 'Only http, https and file links can be opened.'
      this.adapters.openExternal(artifact.url)
      return null
    }
    if (m.status !== 'online') return `${m.name} is offline.`
    const file = (await this.request(m, 'fetchArtifact', [projectId, artifact])) as { name: string; data: string } | { error: string }
    if ('error' in file) return file.error
    const dir = join(tmpdir(), 'symphony-remote', m.id.slice(0, 12))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, basename(file.name))
    await writeFile(path, Buffer.from(file.data, 'base64'))
    return this.adapters.openPath(path)
  }

  /** Window focus: remote machines refresh git counts and GitHub identity too, at most every 10 s each. */
  refreshAll(): void {
    const now = Date.now()
    for (const m of this.machines.values()) {
      if (m.status !== 'online' || now - m.lastRefresh < REFRESH_MIN_MS) continue
      m.lastRefresh = now
      m.wire?.send({ t: 'refresh' })
    }
  }

  // ---------- merged state and layout ----------

  snapshot(): AppSnapshot {
    const s = this.core.snapshot()
    const merged: AppSnapshot = { ...s, projects: [...s.projects], sessions: [...s.sessions], agents: [...s.agents], skills: [...s.skills], mcp: [...s.mcp], git: { ...s.git }, loops: [...s.loops] }
    for (const m of this.machines.values()) {
      const v = m.mirror.view()
      merged.projects.push(...v.projects)
      merged.sessions.push(...v.sessions)
      merged.agents.push(...v.agents)
      merged.skills.push(...v.skills)
      merged.mcp.push(...v.mcp)
      merged.loops.push(...v.loops)
      Object.assign(merged.git, v.git)
    }
    merged.machines = [...[...this.machines.values()].map((m) => this.state(m)), ...[...this.pairings.values()].filter((p) => !this.machines.has(p.id)).map((p) => this.pairingState(p))]
    return merged
  }

  private state(m: Machine): MachineState {
    const s = m.mirror.snapshot
    const pairing = this.pairings.get(m.id)
    return {
      id: m.id,
      name: m.name,
      platform: m.platform,
      appVersion: m.appVersion,
      status: pairing ? 'pairing' : m.status,
      since: m.since,
      outdated: m.outdated || undefined,
      health: m.health,
      position: this.machinePosition(m.id),
      hubPosition: m.mirror.hubPosition(),
      gh: s?.gh ?? { installed: false, hosts: {} },
      models: s?.models ?? [],
      defaultModel: s?.defaultModel ?? 'opus',
      efforts: s?.efforts ?? {},
      autoApprove: !!s?.autoApprove,
      terminals: m.terminals,
      pairCode: pairing?.code
    }
  }

  private pairingState(p: Pairing): MachineState {
    const known = this.machines.get(p.id)
    if (known) return this.state(known)
    const position = this.newMachinePosition(p.id)
    return {
      id: p.id,
      name: p.hello.machineName,
      platform: p.hello.platform,
      appVersion: p.hello.appVersion,
      status: 'pairing',
      since: Date.now(),
      position,
      hubPosition: { x: position.x, y: position.y + 200 },
      gh: { installed: false, hosts: {} },
      models: [],
      defaultModel: 'opus',
      efforts: {},
      autoApprove: false,
      terminals: false,
      pairCode: p.code
    }
  }

  private add(id: string, name: string, platform: string): Machine {
    const m: Machine = {
      id,
      name,
      platform,
      appVersion: '',
      outdated: false,
      status: 'offline',
      since: Date.now(),
      lastSeen: Date.now(),
      terminals: false,
      wire: null,
      pending: new Map(),
      lastRefresh: 0,
      mirror: undefined as unknown as MachineMirror
    }
    m.mirror = new MachineMirror(id, () => this.layout(id), () => this.machinePosition(id), {
      emit: (e) => {
        if (e.type === 'transcript') this.prefetch(m, e.item.kind === 'files' ? e.item.files : e.item.kind === 'tool' ? (e.item.result?.files ?? []) : [], e.sessionId)
        if (e.type === 'loop') this.prefetch(m, waitingFiles(e.loop), e.loop.id)
        if (e.type === 'sessionRemoved' || e.type === 'loopRemoved') this.dropOwners(m.id, (owner) => owner === e.id)
        if (e.type === 'login' && e.prompt.url && e.prompt.url !== m.loginUrl) {
          // The person is here, so the sign-in page opens on this machine.
          m.loginUrl = e.prompt.url
          this.adapters.openExternal(e.prompt.url)
        }
        this.emit(e)
      },
      resync: () => m.wire?.send({ t: 'snapshotRequest' }),
      machineChanged: () => this.emit({ type: 'machine', machine: this.state(m) }),
      changed: () => this.save(m)
    })
    this.machines.set(id, m)
    return m
  }

  /** This machine's layout of one remote machine's nodes (kept in its own state). */
  private layout(id: string): Record<string, Point> {
    return (this.core.state.remoteLayout[id] ??= {})
  }

  private machinePosition(id: string): Point {
    return this.layout(id)[machineNodeId(id)] ?? this.newMachinePosition(id)
  }

  /** Below everything already on the graph. */
  private newMachinePosition(id: string): Point {
    const s = this.core.state
    const ys = [s.hubPosition.y, ...s.projects.map((p) => p.position.y)]
    for (const [mid, nodes] of Object.entries(s.remoteLayout)) if (mid !== id) ys.push(...Object.values(nodes).map((p) => p.y))
    for (const m of this.machines.values()) if (m.id !== id) ys.push(...m.mirror.view().projects.map((p) => p.position.y))
    return { x: s.hubPosition.x, y: Math.max(...ys) + 620 }
  }

  /** Positions of remote nodes stay on this machine and never cross the link. */
  private moveNode(id: string, position: Point): Promise<void> | void {
    if (id === LOCAL_MACHINE_NODE) {
      this.core.state.machinePosition = position
      return this.core.persist()
    }
    const owner = id.startsWith('machine:') ? id.slice(8) : (splitMachine(id)?.machineId ?? [...this.machines.values()].find((m) => m.mirror.owns(id))?.id)
    if (!owner || !this.machines.has(owner)) return this.core.invokeLocal('moveNode', [id, position]) as Promise<void>
    this.layout(owner)[id] = position
    this.core.persist()
  }

  private save(m: Machine): void {
    if (!this.machines.has(m.id)) return
    saveJson(remoteFile(m.id), (): SavedMachine => ({ name: m.name, platform: m.platform, appVersion: m.appVersion, lastSeen: m.lastSeen, ...m.mirror.toJSON() }), 2000)
  }

  // ---------- revoke and status ----------

  revoke(id: string): void {
    const pairing = this.pairings.get(id)
    if (pairing) this.endPairing(pairing, true)
    const m = this.machines.get(id)
    this.settings.machines = this.settings.machines.filter((x) => x.id !== id)
    saveSettings(this.settings)
    if (!m) return
    this.machines.delete(id)
    m.wire?.close('revoke')
    for (const p of m.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(`${m.name} was removed`))
    }
    deleteJson(remoteFile(id))
    this.dropOwners(id, () => true)
    delete this.core.state.remoteLayout[id]
    this.core.persist()
    this.emit({ type: 'machineRemoved', id })
    this.statusChanged()
  }

  status(): RemoteStatus['orchestrator'] {
    return {
      enabled: this.settings.orchestrate,
      port: this.settings.port,
      addresses: [...this.servers.keys()],
      error: this.error,
      machines: [...this.machines.values()].map((m) => ({ id: m.id, name: m.name, platform: m.platform, status: m.status, lastSeen: m.lastSeen })),
      pairing: [...this.pairings.values()].map((p) => ({ id: p.id, name: p.hello.machineName, code: p.code, accepted: p.accepted }))
    }
  }
}

/** The files a loop hands to the step it waits on: what a human reviewer will look at. */
function waitingFiles(l: LoopInfo): AssetRef[] {
  if (l.state !== 'waiting' && l.state !== 'paused') return []
  return (l.history.at(-1)?.artifacts ?? []).flatMap((a) => (a.asset ? [a.asset] : []))
}

/**
 * IPv4 addresses on private and link-local networks, plus loopback (for a second instance on this
 * machine). SYMPHONY_REMOTE_LOOPBACK limits it to loopback, for test runs.
 */
export function lanAddresses(): string[] {
  if (process.env.SYMPHONY_REMOTE_LOOPBACK) return ['127.0.0.1']
  const out = new Set(['127.0.0.1'])
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [x, y] = a.address.split('.').map(Number)
      if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254)) out.add(a.address)
    }
  }
  return [...out]
}
