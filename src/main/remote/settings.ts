// Remote orchestration settings for both roles, in remote.json, and the remote machine's audit log.
import { DEFAULT_GRACE_SECONDS, DEFAULT_PORT } from '@shared/remote'
import type { AuditEntry, DiscoveredOrchestrator } from '@shared/types'
import { home } from '../platform'
import { appendLine, loadJson, readLines, saveJson } from '../store'

export interface PairedMachine {
  id: string
  name: string
  platform: string
  pairedAt: number
}

export interface RemoteSettings {
  // ----- this machine as orchestrator -----
  orchestrate: boolean
  port: number
  /** Machines allowed to link (their certificate fingerprints are pinned). */
  machines: PairedMachine[]
  // ----- this machine as a remote machine -----
  remoteMode: boolean
  /** The paired orchestrator; its fingerprint is pinned. */
  orchestrator: DiscoveredOrchestrator | null
  /** Read-only time after the link drops; 0 frees the window at once. */
  graceSeconds: number
  /** Projects can only be added from these folders. */
  sharedFolders: string[]
  /** Let the orchestrator open terminals here. */
  terminals: boolean
}

const FILE = 'remote.json'

export function loadSettings(): RemoteSettings {
  const fallback: RemoteSettings = {
    orchestrate: false,
    port: DEFAULT_PORT,
    machines: [],
    remoteMode: false,
    orchestrator: null,
    graceSeconds: DEFAULT_GRACE_SECONDS,
    sharedFolders: [home],
    terminals: false
  }
  return { ...fallback, ...loadJson<Partial<RemoteSettings>>(FILE, {}) }
}

export function saveSettings(s: RemoteSettings): void {
  saveJson(FILE, () => s, 0)
}

const AUDIT = 'audit.log'

/** Record an action the orchestrator took on this machine. */
export function audit(action: string, detail?: string): void {
  const entry: AuditEntry = { at: Date.now(), action, ...(detail ? { detail } : {}) }
  try {
    appendLine(AUDIT, JSON.stringify(entry))
  } catch (err) {
    console.error('[audit]', err)
  }
}

export function readAudit(limit = 300): AuditEntry[] {
  return readLines(AUDIT)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as AuditEntry
      } catch {
        return null
      }
    })
    .filter((e): e is AuditEntry => !!e)
    .reverse()
}
