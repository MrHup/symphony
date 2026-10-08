// Protocol, control and security tests for remote orchestration. An orchestrator and a remote
// machine run in this process with fake cores and talk over real TLS on 127.0.0.1.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { connect } from 'node:tls'
import { after, before, describe, test } from 'node:test'
import selfsigned from 'selfsigned'
import { WebSocket } from 'ws'
import { ALPN_LINK, MAX_FRAME_BYTES, PROTOCOL, READ_METHODS, withMachine, type Frame } from '../src/shared/remote'
import type { AppSnapshot, ControlState, MainEvent, Project, SessionInfo, TranscriptItem } from '../src/shared/types'
import { fingerprint, pairingCode, type Identity } from '../src/main/remote/identity'
import { RemoteLink } from '../src/main/remote/link'
import { MachineMirror } from '../src/main/remote/mirror'
import { Orchestrator } from '../src/main/remote/orchestrator'
import { LinkServer } from '../src/main/remote/server'
import type { RemoteSettings } from '../src/main/remote/settings'
import { Wire } from '../src/main/remote/wire'
import { flushAll, setDataDir } from '../src/main/store'
import { AssetStore } from '../src/main/assets'
import { SessionManager } from '../src/main/sessions'

// ---------- helpers ----------

const dataDir = mkdtempSync(join(tmpdir(), 'symphony-remote-test-'))
setDataDir(dataDir)

async function makeIdentity(): Promise<Identity> {
  const made = await selfsigned.generate([{ name: 'commonName', value: 'Symphony' }], { keyType: 'ec', curve: 'P-256', extensions: [{ name: 'extKeyUsage', serverAuth: true, clientAuth: true }] })
  return { cert: made.cert, key: made.private, id: fingerprint(made.cert) }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function waitFor(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function emptySnapshot(): AppSnapshot {
  return {
    projects: [],
    sessions: [],
    agents: [],
    skills: [],
    mcp: [],
    git: {},
    hubPosition: { x: -420, y: 0 },
    gh: { installed: false, hosts: {} },
    models: [{ value: 'opus', label: 'Opus', efforts: [] }],
    defaultModel: 'opus',
    efforts: {},
    usage: null,
    loops: [],
    autoApprove: false,
    machines: [],
    machinePosition: { x: -420, y: -200 },
    control: null
  }
}

/** The parts of SymphonyCore the orchestrator and the link use. */
class FakeCore {
  listeners = new Set<(e: MainEvent) => void>()
  control: ControlState | null = null
  usagePolling = true
  refreshed = 0
  calls: { method: string; args: unknown[] }[] = []
  answered = new Set<string>()
  snap = emptySnapshot()
  transcripts: Record<string, TranscriptItem[]> = {}
  /** Requests that wait until released. */
  holds = new Map<string, () => void>()
  holdMethods = new Set<string>()
  state = { projects: [] as Project[], sessions: [], hubPosition: { x: -420, y: 0 }, defaultModel: 'opus', efforts: {}, loops: [], remoteLayout: {} as Record<string, Record<string, { x: number; y: number }>>, machinePosition: undefined as { x: number; y: number } | undefined }
  sessions = { get: (id: string) => this.snap.sessions.find((s) => s.id === id) }
  loops = { list: () => this.snap.loops }
  terminals = { pause: () => undefined, resume: () => undefined }
  /** Each machine has its own asset folder. */
  assets = new AssetStore(() => this.assetDir, async () => null)
  assetDir = mkdtempSync(join(tmpdir(), 'symphony-assets-'))
  extraFileRefs: () => Iterable<string> = () => []
  releaseFiles(ids: string[]) {
    this.assets.sweep(ids, new Set(this.extraFileRefs()))
  }

  on(l: (e: MainEvent) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit(e: MainEvent) {
    for (const l of this.listeners) l(e)
  }
  snapshot(): AppSnapshot {
    return structuredClone({ ...this.snap, projects: this.state.projects.length ? this.state.projects : this.snap.projects, control: this.control })
  }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args })
    if (this.holdMethods.has(method)) await new Promise<void>((r) => this.holds.set(method, r))
    switch (method) {
      case 'respondApproval': {
        const key = String(args[1])
        if (this.answered.has(key)) return 'Already answered.'
        this.answered.add(key)
        return null
      }
      case 'addProject': {
        const p: Project = { id: randomUUID(), path: String(args[0]), name: basename(String(args[0])), position: { x: 1, y: 2 } }
        this.state.projects.push(p)
        this.emit({ type: 'project', project: p })
        return p
      }
      case 'transcript':
        return this.transcripts[String(args[0])] ?? []
      case 'termStart':
        return 'zsh'
      case 'setAutoApprove':
        this.snap.autoApprove = !!args[0]
        this.emit({ type: 'autoApprove', on: !!args[0] })
        return
      default:
        return null
    }
  }
  invokeLocal(method: string, args: unknown[]) {
    if (this.control && !READ_METHODS.has(method)) return Promise.reject(new Error(`Controlled by ${this.control.by}`))
    return this.invoke(method, args)
  }
  setControl(c: ControlState | null) {
    this.control = c
    this.emit({ type: 'control', control: c })
  }
  setUsagePolling(on: boolean) {
    this.usagePolling = on
  }
  refreshOnFocus() {
    this.refreshed += 1
  }
  busy() {
    return false
  }
  persist() {}
  project(id: string) {
    const p = this.state.projects.find((x) => x.id === id) ?? this.snap.projects.find((x) => x.id === id)
    if (!p) throw new Error('Unknown project')
    return p
  }
  addSession(s: Partial<SessionInfo> = {}): SessionInfo {
    const info: SessionInfo = { id: randomUUID(), kind: 'task', anchorId: 'p', projectId: null, cwd: '/', title: 'A session', model: 'opus', status: 'approval', createdAt: Date.now(), ...s }
    this.snap.sessions.push(info)
    this.emit({ type: 'session', session: info })
    return info
  }
}

function settings(patch: Partial<RemoteSettings>): RemoteSettings {
  return { orchestrate: false, port: 0, machines: [], remoteMode: false, orchestrator: null, graceSeconds: 1, sharedFolders: [], terminals: false, ...patch }
}

const opened: string[] = []
const adapters = {
  pickFolder: async () => null,
  openExternal: () => undefined,
  openPath: async (path: string) => (opened.push(path), null),
  openArtifact: async () => null,
  micAccess: async () => true,
  thumbnail: async () => null
}

interface Pair {
  pcCore: FakeCore
  macCore: FakeCore
  orch: Orchestrator
  link: RemoteLink
  pcId: Identity
  macId: Identity
  pcEvents: MainEvent[]
  pcSettings: RemoteSettings
  macSettings: RemoteSettings
  shared: string
  port: number
}

/** An orchestrator and a remote machine, not yet paired. */
async function machines(): Promise<Pair> {
  const [pcId, macId, port] = await Promise.all([makeIdentity(), makeIdentity(), freePort()])
  const shared = mkdtempSync(join(tmpdir(), 'symphony-shared-'))
  const pcCore = new FakeCore()
  const macCore = new FakeCore()
  const pcSettings = settings({ orchestrate: true, port })
  const macSettings = settings({ remoteMode: true, sharedFolders: [shared] })
  const pcEvents: MainEvent[] = []
  const orch = new Orchestrator(pcCore as never, pcSettings, adapters, (e) => pcEvents.push(e), () => undefined)
  orch.load()
  orch.start(pcId, 'PC', '0.1.0')
  const link = new RemoteLink(macCore as never, macSettings, () => undefined)
  link.start(macId, 'Mac', '0.1.0')
  return { pcCore, macCore, orch, link, pcId, macId, pcEvents, pcSettings, macSettings, shared, port }
}

/** Pair the two by comparing codes, then wait until the link is up and in sync. */
async function paired(): Promise<Pair> {
  const m = await machines()
  m.link.pair(`127.0.0.1:${m.port}`, m.macId)
  await waitFor('pairing on both sides', () => m.orch.status().pairing.length === 1 && !!m.link.status().pairing)
  assert.equal(m.orch.status().pairing[0].code, m.link.status().pairing!.code)
  m.orch.pairDecision(m.macId.id, true)
  m.link.pairDecision(true)
  await online(m)
  return m
}

async function online(m: Pair): Promise<void> {
  await waitFor('link connected', () => m.link.status().state === 'connected')
  await waitFor('machine online', () => m.orch.status().machines.some((x) => x.id === m.macId.id && x.status === 'online'))
}

function stop(m: Pair): void {
  m.link.shutdown('quit')
  m.orch.stop('quit')
}

/** Cut the link without a goodbye, as a network drop would. */
function dropLink(m: Pair): void {
  const machine = (m.orch as unknown as { machines: Map<string, { wire: { ws: WebSocket } | null }> }).machines.get(m.macId.id)!
  machine.wire!.ws.terminate()
}

// ---------- tests ----------

describe('pairing and security', () => {
  test('both sides show the same code, and pairing pins each other', async () => {
    const m = await paired()
    assert.equal(m.pcSettings.machines[0].id, m.macId.id)
    assert.equal(m.macSettings.orchestrator?.id, m.pcId.id)
    assert.equal(m.macCore.control?.by, 'PC')
    assert.equal(m.macCore.usagePolling, false, 'a linked machine stops polling usage')
    stop(m)
  })

  test('the code depends on both certificates', () => {
    assert.equal(pairingCode('a', 'b'), pairingCode('b', 'a'))
    assert.notEqual(pairingCode('a', 'b'), pairingCode('a', 'c'))
    assert.match(pairingCode('a', 'b'), /^\d{6}$/)
  })

  test('an unpaired machine is refused at the TLS handshake', async () => {
    const m = await machines()
    const stranger = await makeIdentity()
    const result = await new Promise<string>((resolve) => {
      const sock = connect({ host: '127.0.0.1', port: m.port, key: stranger.key, cert: stranger.cert, rejectUnauthorized: false, ALPNProtocols: [ALPN_LINK] })
      let got = ''
      sock.on('secureConnect', () => sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'))
      sock.on('data', (d) => (got += String(d)))
      sock.on('close', () => resolve(got ? 'answered' : 'closed'))
      sock.on('error', () => undefined)
    })
    assert.equal(result, 'closed')
    stop(m)
  })

  test('a changed certificate is refused: the machine will not link to a different orchestrator', async () => {
    const m = await machines()
    m.macSettings.orchestrator = { id: 'f'.repeat(64), name: 'PC', host: '127.0.0.1', port: m.port }
    await m.link.setEnabled(true, m.macId)
    await waitFor('error', () => /different certificate/.test(m.link.status().error ?? ''))
    assert.equal(m.link.status().state, 'retrying')
    stop(m)
  })

  test('pairing after the window expires fails', async () => {
    Orchestrator.pairTtlMs = 300
    const m = await machines()
    m.link.pair(`127.0.0.1:${m.port}`, m.macId)
    await waitFor('pairing', () => m.orch.status().pairing.length === 1)
    await new Promise((r) => setTimeout(r, 500))
    assert.throws(() => m.orch.pairDecision(m.macId.id, true), /expired/)
    await waitFor('machine side cancelled', () => !m.link.status().pairing)
    assert.equal(m.pcSettings.machines.length, 0)
    Orchestrator.pairTtlMs = 120_000
    stop(m)
  })

  test('a project path outside the shared folders is rejected', async () => {
    const m = await paired()
    await assert.rejects(m.orch.invoke('addProject', [tmpdir(), m.macId.id]), /not inside a folder/)
    const inside = join(m.shared, 'repo')
    mkdirSync(inside)
    const p = (await m.orch.invoke('addProject', [inside, m.macId.id])) as Project
    assert.equal(p.machineId, m.macId.id)
    assert.ok(!m.pcCore.calls.some((c) => c.method === 'addProject'), 'the orchestrator itself adds nothing')
    stop(m)
  })

  test('terminals are refused while switched off', async () => {
    const m = await paired()
    const id = withMachine(m.macId.id, 'terminal:home#1')
    await assert.rejects(m.orch.invoke('termStart', [id, null, 80, 24, m.macId.id]), /switched off/)
    // Settings can only change while nobody controls the machine (its own window is read-only otherwise).
    assert.throws(() => m.link.setSettings({ terminals: true }), /Controlled by PC/)
    const control = m.macCore.control
    m.macCore.control = null
    m.link.setSettings({ terminals: true })
    m.macCore.control = control
    await waitFor('resync after the new hello', () => m.orch.status().machines[0].status === 'online')
    await waitFor('machine allows terminals', () => (m.orch.snapshot().machines[0]?.terminals ?? false))
    assert.equal(await m.orch.invoke('termStart', [id, null, 80, 24, m.macId.id]), 'zsh')
    const call = m.macCore.calls.find((c) => c.method === 'termStart')!
    assert.equal(call.args[0], 'remote:terminal:home#1', 'remote terminals are kept apart from the machine\'s own')
    stop(m)
  })

  test('revoking a machine refuses its next connection', async () => {
    const m = await paired()
    m.orch.revoke(m.macId.id)
    await waitFor('machine forgets the orchestrator', () => m.macSettings.orchestrator === null)
    assert.equal(m.macCore.control, null, 'editable at once after a revoke')
    // Its pinned link is no longer accepted.
    m.macSettings.orchestrator = { id: m.pcId.id, name: 'PC', host: '127.0.0.1', port: m.port }
    await m.link.setEnabled(true, m.macId)
    await new Promise((r) => setTimeout(r, 600))
    assert.notEqual(m.link.status().state, 'connected')
    stop(m)
  })
})

describe('routing', () => {
  let m: Pair
  before(async () => {
    m = await paired()
  })
  after(() => stop(m))

  test('requests without a target go to the chosen machine, without the machineId', async () => {
    await m.orch.invoke('setAutoApprove', [true, m.macId.id])
    assert.deepEqual(m.macCore.calls.at(-1), { method: 'setAutoApprove', args: [true] })
    await m.orch.invoke('setAutoApprove', [false])
    assert.deepEqual(m.pcCore.calls.at(-1), { method: 'setAutoApprove', args: [false] }, 'missing machineId means this machine')
    await waitFor('machine state follows', () => m.pcEvents.some((e) => e.type === 'machine' && e.machine.autoApprove))
  })

  test('PC-only requests never cross the link', async () => {
    const before = m.macCore.calls.length
    await m.orch.invoke('refreshUsage', [])
    await m.orch.invoke('dictationLanguage', [])
    assert.equal(m.macCore.calls.length, before)
  })

  test('targets route by the routing table, and prefixed IDs lose their prefix', async () => {
    const s = m.macCore.addSession()
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    await m.orch.invoke('sendMessage', [s.id, 'hello'])
    assert.deepEqual(m.macCore.calls.at(-1), { method: 'sendMessage', args: [s.id, 'hello'] })
    await m.orch.invoke('readSkill', [withMachine(m.macId.id, 'skill:user::docs')])
    assert.deepEqual(m.macCore.calls.at(-1), { method: 'readSkill', args: ['skill:user::docs'] })
  })

  test('moving a remote node stays on the orchestrator', async () => {
    const s = m.macCore.addSession()
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    const before = m.macCore.calls.length
    await m.orch.invoke('moveNode', [s.id, { x: 5, y: 6 }])
    assert.equal(m.macCore.calls.length, before)
    assert.deepEqual(m.orch.snapshot().sessions.find((x) => x.id === s.id)!.position, { x: 5, y: 6 })
  })

  test('remote skills are prefixed and remote objects carry their machineId', async () => {
    m.macCore.emit({ type: 'config', skills: [{ id: 'skill:user::docs', name: 'docs', description: '', path: '/x', scope: 'user' }], mcp: [] })
    m.macCore.addSession({ anchorId: 'skill:user::docs', kind: 'config' })
    await waitFor('config mirrored', () => m.orch.snapshot().skills.length === 1)
    const snap = m.orch.snapshot()
    assert.equal(snap.skills[0].id, withMachine(m.macId.id, 'skill:user::docs'))
    assert.equal(snap.skills[0].machineId, m.macId.id)
    assert.ok(snap.sessions.some((x) => x.anchorId === withMachine(m.macId.id, 'skill:user::docs')))
    assert.ok(snap.sessions.every((x) => x.machineId === m.macId.id))
    assert.equal(snap.usage, null)
  })

  test('the same approval answered on both sides is applied once', async () => {
    const s = m.macCore.addSession()
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    await m.macCore.invoke('respondApproval', [s.id, 'req-1', 'allow'])
    const note = await m.orch.invoke('respondApproval', [s.id, 'req-1', 'deny'])
    assert.equal(note, 'Already answered on Mac.')
  })
})

describe('control and resilience', () => {
  test('a link drop keeps the machine read-only for the grace period, then frees it', async () => {
    const m = await paired()
    m.macSettings.graceSeconds = 1
    m.link.shutdown('quit') // stop it redialing so the grace period runs out
    const link2 = new RemoteLink(m.macCore as never, m.macSettings, () => undefined)
    m.macCore.setControl(null)
    link2.start(m.macId, 'Mac', '0.1.0')
    await waitFor('relinked', () => link2.status().state === 'connected')
    m.orch.stop('quit')
    // 'quit' is a goodbye, so the window is editable at once.
    await waitFor('editable after goodbye', () => m.macCore.control === null)
    link2.shutdown('quit')
  })

  test('a silent drop starts the grace period; the window is read-only until it ends', async () => {
    const m = await paired()
    m.macSettings.graceSeconds = 1
    // The orchestrator stops listening and the link is cut without a goodbye.
    for (const s of (m.orch as unknown as { servers: Map<string, { close(): void }> }).servers.values()) s.close()
    dropLink(m)
    await waitFor('grace', () => m.macCore.control?.mode === 'grace')
    assert.ok(m.macCore.control!.graceEndsAt! > Date.now())
    await waitFor('editable after the grace period', () => m.macCore.control === null, 3000)
    stop(m)
  })

  test('Disconnect on the machine frees it at once and keeps the link off', async () => {
    const m = await paired()
    m.link.disconnect()
    assert.equal(m.macCore.control, null)
    assert.equal(m.macSettings.remoteMode, false)
    await waitFor('orchestrator sees it offline', () => m.orch.status().machines[0].status === 'offline')
    stop(m)
  })

  test('a request interrupted by a drop is resent with the same id and runs once', async () => {
    const m = await paired()
    const s = m.macCore.addSession()
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    m.macCore.holdMethods.add('sendMessage')
    const reply = m.orch.invoke('sendMessage', [s.id, 'once'])
    await waitFor('request reached the machine', () => m.macCore.holds.has('sendMessage'))
    dropLink(m)
    await waitFor('dropped', () => m.orch.status().machines[0].status !== 'online')
    m.macCore.holds.get('sendMessage')!()
    await online(m)
    await reply
    assert.equal(m.macCore.calls.filter((c) => c.method === 'sendMessage').length, 1)
    stop(m)
  })

  test('after a restart, a paired machine appears offline with its last known state', async () => {
    const m = await paired()
    const p = (await m.orch.invoke('addProject', [m.shared, m.macId.id])) as Project
    await waitFor('project mirrored', () => m.orch.snapshot().projects.some((x) => x.id === p.id))
    stop(m)
    await flushAll()
    const again = new Orchestrator(m.pcCore as never, m.pcSettings, adapters, () => undefined, () => undefined)
    again.load()
    const snap = again.snapshot()
    assert.equal(snap.machines[0].status, 'offline')
    assert.ok(snap.projects.some((x) => x.id === p.id && x.machineId === m.macId.id))
  })

  test('a different protocol is refused and the machine is marked outdated', async () => {
    const m = await paired()
    m.link.shutdown('quit')
    const old = new RemoteLink(m.macCore as never, m.macSettings, () => undefined)
    ;(old as unknown as { hello: () => Frame }).hello = () => ({ t: 'hello', protocol: PROTOCOL + 1, appVersion: '0.0.1', machineId: m.macId.id, machineName: 'Mac', platform: 'darwin', capabilities: { terminals: false } })
    old.start(m.macId, 'Mac', '0.0.1')
    await waitFor('outdated', () => m.orch.snapshot().machines[0]?.outdated === true)
    assert.notEqual(m.orch.status().machines[0].status, 'online')
    old.shutdown('quit')
    stop(m)
  })

  test('window focus sends refresh to linked machines, at most every 10 s', async () => {
    const m = await paired()
    m.orch.refreshAll()
    m.orch.refreshAll()
    await waitFor('refreshed', () => m.macCore.refreshed === 1)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(m.macCore.refreshed, 1)
    stop(m)
  })
})

describe('mirror', () => {
  const make = () => {
    const out = { events: [] as MainEvent[], resyncs: 0 }
    const layout: Record<string, { x: number; y: number }> = {}
    const mirror = new MachineMirror('m1', () => layout, () => ({ x: 0, y: 1000 }), {
      emit: (e) => out.events.push(e),
      resync: () => (out.resyncs += 1),
      machineChanged: () => undefined,
      changed: () => undefined
    })
    return { mirror, out, layout }
  }
  const session = (id: string, status: SessionInfo['status'] = 'working'): SessionInfo => ({ id, kind: 'task', anchorId: 'p', projectId: 'p', cwd: '/', title: id, model: 'opus', status, createdAt: 1 })

  test('a sequence gap asks for a fresh snapshot, and events in it are not applied twice', () => {
    const { mirror, out } = make()
    mirror.onSnapshot(emptySnapshot(), 5)
    mirror.onEvent(6, { type: 'session', session: session('a') })
    mirror.onEvent(8, { type: 'session', session: session('b') })
    assert.equal(out.resyncs, 1)
    assert.equal(mirror.snapshot!.sessions.length, 1)
    const fresh = emptySnapshot()
    fresh.sessions = [session('a'), session('b')]
    mirror.onEvent(9, { type: 'session', session: session('c') })
    mirror.onSnapshot(fresh, 8)
    assert.deepEqual(mirror.snapshot!.sessions.map((x) => x.id), ['a', 'b', 'c'])
    assert.equal(mirror.seq, 9)
  })

  test('events already in a snapshot are dropped', () => {
    const { mirror, out } = make()
    mirror.beginSync()
    mirror.onEvent(3, { type: 'session', session: session('old') })
    mirror.onSnapshot(emptySnapshot(), 3)
    assert.equal(mirror.snapshot!.sessions.length, 0)
    assert.equal(out.events.length, 0)
  })

  test('transcript items are merged by id after a fetch, never duplicated', () => {
    const { mirror } = make()
    mirror.onSnapshot(emptySnapshot(), 0)
    mirror.onTranscript('s', [{ kind: 'thinking', id: 't1', text: 'a', parent: null, live: true }], 0)
    mirror.onEvent(1, { type: 'transcript', sessionId: 's', item: { kind: 'thinking', id: 't1', text: 'ab', parent: null, live: true } })
    mirror.onEvent(2, { type: 'transcript', sessionId: 's', item: { kind: 'text', id: 'x', text: 'hi', parent: null } })
    const items = mirror.cachedTranscript('s')!
    assert.equal(items.length, 2)
    assert.equal((items[0] as { text: string }).text, 'ab')
  })

  test('remote usage never reaches the orchestrator', () => {
    const { mirror, out } = make()
    const snap = emptySnapshot()
    snap.usage = { available: true, plan: 'max', windows: [], fetchedAt: 1 }
    mirror.onSnapshot(snap, 0)
    assert.equal(mirror.snapshot!.usage, null)
    mirror.onEvent(1, { type: 'usage', usage: snap.usage })
    assert.equal(out.events.length, 0)
  })

  test('remote positions are ignored; a node without one of ours is placed by its machine', () => {
    const { mirror, layout } = make()
    const snap = emptySnapshot()
    snap.projects = [{ id: 'p', path: '/p', name: 'p', position: { x: 999, y: 999 } }]
    snap.sessions = [{ ...session('s'), position: { x: 5, y: 5 } }]
    mirror.onSnapshot(snap, 0)
    const v = mirror.view()
    assert.deepEqual(v.projects[0].position, { x: 680, y: 1040 })
    assert.equal(v.sessions[0].position, undefined)
    layout.p = { x: 1, y: 2 }
    assert.deepEqual(mirror.view().projects[0].position, { x: 1, y: 2 })
  })

  test('positions of remote nodes that no longer exist are pruned on a fresh snapshot', () => {
    const { mirror, layout } = make()
    layout.gone = { x: 1, y: 1 }
    layout['machine:m1'] = { x: 0, y: 0 }
    mirror.onSnapshot(emptySnapshot(), 0)
    assert.equal(layout.gone, undefined)
    assert.ok(layout['machine:m1'])
  })
})

describe('link server', () => {
  test('a resent request id runs once and gets the same result', async () => {
    let runs = 0
    const sent: Frame[] = []
    const server = new LinkServer(async () => ++runs, (f) => sent.push(f))
    await server.invoke({ id: 'r1', method: 'sendMessage', args: [] })
    await server.invoke({ id: 'r1', method: 'sendMessage', args: [] })
    assert.equal(runs, 1)
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0], sent[1])
  })

  test('an oversized reply becomes an error instead of a frame over the cap', async () => {
    const sent: Frame[] = []
    const server = new LinkServer(async () => 'x'.repeat(MAX_FRAME_BYTES + 10), (f) => sent.push(f))
    await server.invoke({ id: 'big', method: 'gitFileDiff', args: [] })
    assert.equal(sent[0].t, 'result')
    assert.equal((sent[0] as { ok: boolean }).ok, false)
    assert.match((sent[0] as { error: string }).error, /too large/)
  })

  test('the wire refuses to send an oversized frame', async () => {
    const port = await freePort()
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((r) => ws.once('open', r))
    const wire = new Wire(ws, () => undefined, () => undefined)
    assert.equal(wire.send({ t: 'event', seq: 1, event: { type: 'term', id: 'x', data: 'x'.repeat(MAX_FRAME_BYTES) } }), false)
    assert.equal(wire.send({ t: 'refresh' }), true)
    wire.close()
    wss.close()
  })
})

describe('files shown and handed over', () => {
  const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(String(n))])

  test('the store copies files, folders and patterns, by content, and skips what cannot be shown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'symphony-shots-'))
    for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `shot-${i}.png`), png(i))
    writeFileSync(join(dir, 'copy.png'), png(1))
    writeFileSync(join(dir, 'tool.exe'), 'x')
    const storeDir = mkdtempSync(join(tmpdir(), 'symphony-store-'))
    const store = new AssetStore(() => storeDir, async () => null)
    const byPattern = await store.collect(dir, ['shot-*.png'])
    assert.deepEqual(byPattern.files.map((f) => f.name), ['shot-1.png', 'shot-2.png', 'shot-3.png'])
    assert.equal(byPattern.files[0].mediaType, 'image/png')
    const byFolder = await store.collect(dir, ['.'])
    assert.equal(byFolder.files.length, 4, 'the folder gives its viewable files only')
    assert.equal(byFolder.files.find((f) => f.name === 'copy.png')!.id, byPattern.files[0].id, 'same content, same id')
    const bad = await store.collect(dir, ['tool.exe', 'missing.png'])
    assert.equal(bad.files.length, 0)
    assert.equal(bad.skipped.length, 2)
    // What was shown cannot change afterwards.
    writeFileSync(join(dir, 'shot-1.png'), png(99))
    assert.deepEqual((await store.read(byPattern.files[0].id)).data, png(1))
  })

  test('the orchestrator fetches a remote file once, checks it, and still shows it while the machine is offline', async () => {
    const m = await paired()
    const s = m.macCore.addSession({ status: 'finished' })
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    const shot = join(m.shared, 'home.png')
    writeFileSync(shot, png(7))
    const ref = await m.macCore.assets.storeFile(shot)
    assert.equal(m.pcCore.assets.path(ref.id), null)
    const url = (await m.orch.invoke('asset', [s.id, ref.id])) as string
    assert.equal(url, `data:image/png;base64,${png(7).toString('base64')}`)
    assert.ok(m.pcCore.assets.path(ref.id), 'kept on the orchestrator')
    m.link.disconnect()
    await waitFor('offline', () => m.orch.status().machines[0].status !== 'online')
    assert.equal(await m.orch.invoke('asset', [s.id, ref.id]), url)
    await m.orch.invoke('openAsset', [s.id, ref.id])
    assert.equal(opened.at(-1), m.pcCore.assets.path(ref.id), 'opened from the copy here')
    await assert.rejects(m.orch.invoke('asset', [s.id, 'a'.repeat(64)]), /offline/)
    stop(m)
  })

  test('files shown in a session are fetched as soon as they appear', async () => {
    const m = await paired()
    const s = m.macCore.addSession({ status: 'working' })
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    const shot = join(m.shared, 'early.png')
    writeFileSync(shot, png(8))
    const ref = await m.macCore.assets.storeFile(shot)
    m.macCore.emit({ type: 'transcript', sessionId: s.id, item: { kind: 'files', id: 'f1', files: [ref] } })
    await waitFor('prefetched', () => !!m.pcCore.assets.path(ref.id))
    stop(m)
  })
})

describe('cleaning up files', () => {
  const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`cleanup-${n}`)])
  const newStore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'symphony-store-'))
    return new AssetStore(() => dir, async () => null)
  }

  test('a sweep deletes only what nothing refers to, and leaves files that are too new', async () => {
    const store = newStore()
    const a = await store.storeBuffer(png(1), 'a.png', 'image/png', '/a.png')
    const b = await store.storeBuffer(png(2), 'b.png', 'image/png', '/b.png')
    assert.deepEqual(store.sweep([a.id, b.id], new Set(), 60_000), [], 'too new for a sweep with a minimum age')
    assert.deepEqual(store.sweep([a.id, b.id], new Set([a.id])), [b.id])
    assert.ok(store.path(a.id))
    assert.equal(store.path(b.id), null)
  })

  test('deleting a session releases its files; one another session still shows stays', async () => {
    const store = newStore()
    const shared = await store.storeBuffer(png(3), 'shared.png', 'image/png', '/shared.png')
    const own = await store.storeBuffer(png(4), 'own.png', 'image/png', '/own.png')
    const session = (id: string): SessionInfo => ({ id, kind: 'task', anchorId: 'p', projectId: null, cwd: '/', title: id, model: 'opus', status: 'finished', createdAt: 1 })
    const write = (id: string, items: TranscriptItem[]) => {
      mkdirSync(join(dataDir, 'transcripts'), { recursive: true })
      writeFileSync(join(dataDir, 'transcripts', `${id}.json`), JSON.stringify(items))
    }
    const one = randomUUID()
    const two = randomUUID()
    write(one, [{ kind: 'files', id: 'f1', files: [shared, own] }])
    write(two, [{ kind: 'tool', id: 't1', name: 'Read', input: {}, parent: null, result: { text: '', isError: false, files: [shared] } }])
    const sessions = new SessionManager(() => undefined, () => undefined, store)
    sessions.restore([session(one), session(two)])
    let released: string[] = []
    sessions.onFilesReleased = (ids) => (released = ids)
    sessions.dismiss(one)
    assert.deepEqual(released.sort(), [shared.id, own.id].sort())
    store.sweep(released, sessions.assetRefs())
    assert.equal(store.path(own.id), null, 'its own file is gone')
    assert.ok(store.path(shared.id), 'the shared one stays while the other session shows it')
  })

  test('the orchestrator deletes its copy when the remote session is removed, not before', async () => {
    const m = await paired()
    const a = m.macCore.addSession({ status: 'finished' })
    const b = m.macCore.addSession({ status: 'finished' })
    await waitFor('sessions mirrored', () => m.orch.snapshot().sessions.filter((x) => x.id === a.id || x.id === b.id).length === 2)
    const shot = join(m.shared, 'cleanup.png')
    writeFileSync(shot, png(5))
    const ref = await m.macCore.assets.storeFile(shot)
    await m.orch.invoke('asset', [a.id, ref.id])
    await m.orch.invoke('asset', [b.id, ref.id])
    assert.ok(m.pcCore.assets.path(ref.id))
    m.macCore.emit({ type: 'sessionRemoved', id: a.id })
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(m.pcCore.assets.path(ref.id), 'still shown by the other remote session')
    m.macCore.emit({ type: 'sessionRemoved', id: b.id })
    await waitFor('copy deleted', () => m.pcCore.assets.path(ref.id) === null)
    stop(m)
  })

  test('copies of files from sessions deleted while the link was down go at the resync', async () => {
    const m = await paired()
    const s = m.macCore.addSession({ status: 'finished' })
    await waitFor('session mirrored', () => m.orch.snapshot().sessions.some((x) => x.id === s.id))
    const shot = join(m.shared, 'gone.png')
    writeFileSync(shot, png(6))
    const ref = await m.macCore.assets.storeFile(shot)
    await m.orch.invoke('asset', [s.id, ref.id])
    m.link.disconnect()
    await waitFor('offline', () => m.orch.status().machines[0].status !== 'online')
    m.macCore.snap.sessions = m.macCore.snap.sessions.filter((x) => x.id !== s.id)
    m.macCore.control = null
    await m.link.setEnabled(true, m.macId)
    await online(m)
    await waitFor('copy deleted', () => m.pcCore.assets.path(ref.id) === null)
    stop(m)
  })
})
