// Remote orchestration around the core: this machine as orchestrator (Orchestrator), as a remote
// machine (RemoteLink), or neither (both are off by default). Every request from the window goes
// through here, so it can be routed to the machine that owns its target.
import { READ_METHODS } from '@shared/remote'
import type { MainEvent, RemoteStatus } from '@shared/types'
import type { SymphonyCore } from '../core'
import { machineName, onPower, type Adapters } from '../platform'
import { deviceIdentity, existingIdentityId, type Identity } from './identity'
import { RemoteLink } from './link'
import { Orchestrator } from './orchestrator'
import { loadSettings, readAudit } from './settings'

/** What the window may still do while another machine controls this one. */
const WHILE_CONTROLLED = new Set(['remoteStatus', 'remoteDisconnect', 'remoteAudit'])

export class Remote {
  readonly orchestrator: Orchestrator
  readonly link: RemoteLink
  private settings = loadSettings()
  private identity: Identity | null = null
  private name = ''
  private statusTimer: NodeJS.Timeout | undefined

  constructor(
    private core: SymphonyCore,
    private adapters: Adapters,
    emit: (e: MainEvent) => void,
    private appVersion: string
  ) {
    const changed = () => {
      clearTimeout(this.statusTimer)
      this.statusTimer = setTimeout(() => emit({ type: 'remote', status: this.status() }), 50)
    }
    this.orchestrator = new Orchestrator(core, this.settings, adapters, emit, changed)
    this.link = new RemoteLink(core, this.settings, changed)
  }

  async start(): Promise<void> {
    this.name = await machineName()
    if (this.settings.orchestrate || this.settings.remoteMode) {
      this.identity = await deviceIdentity().catch((err) => {
        console.error('[remote] device identity', err)
        return null
      })
    }
    this.orchestrator.load()
    this.orchestrator.start(this.identity, this.name, this.appVersion)
    this.link.start(this.identity, this.name, this.appVersion)
    onPower({ suspend: () => this.link.onSuspend(), resume: () => this.link.onResume(), change: () => this.link.onPowerChange() })
  }

  /** Quitting: both roles say goodbye so the other side shows "quit" rather than "offline". */
  shutdown(): void {
    this.orchestrator.stop('quit')
    this.link.shutdown('quit')
  }

  /** The window gained focus. */
  focus(): void {
    this.orchestrator.refreshAll()
  }

  /** A request from this machine's window. */
  invoke(method: string, args: unknown[]): Promise<unknown> {
    const control = this.core.control
    if (control && !READ_METHODS.has(method) && !WHILE_CONTROLLED.has(method)) return Promise.reject(new Error(`Controlled by ${control.by}`))
    if (method.startsWith('remote') && method !== 'remoteBrowse') return this.remoteApi(method, args)
    return this.orchestrator.invoke(method, args)
  }

  status(): RemoteStatus {
    return {
      machineName: this.name,
      machineId: this.identity?.id ?? existingIdentityId(),
      orchestrator: this.orchestrator.status(),
      remote: this.link.status()
    }
  }

  private async ensureIdentity(): Promise<Identity> {
    this.identity ??= await deviceIdentity()
    return this.identity
  }

  private async remoteApi(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'remoteStatus':
        return this.status()
      case 'remoteSetOrchestrate':
        return this.orchestrator.setEnabled(!!args[0], await this.ensureIdentity(), this.name)
      case 'remoteSetRemoteMode':
        return this.link.setEnabled(!!args[0], await this.ensureIdentity())
      case 'remotePair':
        return this.link.pair(String(args[0]), await this.ensureIdentity())
      case 'remotePairDecision':
        return args[0] === 'orchestrator' ? this.link.pairDecision(!!args[1]) : this.orchestrator.pairDecision(String(args[0]), !!args[1])
      case 'remoteRevoke':
        return args[0] === 'orchestrator' ? this.link.revoke() : this.orchestrator.revoke(String(args[0]))
      case 'remoteDisconnect':
        return this.link.disconnect()
      case 'remoteSettings': {
        const { port, ...rest } = (args[0] ?? {}) as { port?: number; graceSeconds?: number; sharedFolders?: string[]; terminals?: boolean }
        if (port) this.orchestrator.setPort(port)
        if (Object.keys(rest).length) this.link.setSettings(rest)
        return
      }
      case 'remotePickFolder':
        return this.adapters.pickFolder()
      case 'remoteAudit':
        return readAudit()
      default:
        throw new Error(`Unknown request: ${method}`)
    }
  }
}
