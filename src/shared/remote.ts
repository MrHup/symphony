// The link between an orchestrator (the PC) and a remote machine (a MacBook in remote mode): frame
// types, timings, which requests go where, and the machine prefix on IDs that repeat across machines.
import type { AppSnapshot, MachineHealth, MainEvent } from './types'

/** Must match on both sides; a different app version is allowed. */
export const PROTOCOL = 1
export const DEFAULT_PORT = 47821
/** TLS ALPN names: a normal link (pinned certificates only) and a pairing connection. */
export const ALPN_LINK = 'symphony-link'
export const ALPN_PAIR = 'symphony-pair'
export const MDNS_TYPE = 'symphony'

export const MAX_FRAME_BYTES = 32 * 1024 * 1024
export const PING_MS = 10_000
/** A link with this long of silence counts as offline. */
export const SILENCE_MS = 30_000
export const REQUEST_TIMEOUT_MS = 30_000
/** Requests waiting when a link drops are kept this long for a resend. */
export const RESEND_GRACE_MS = 2 * 60_000
/** The remote machine remembers results this long, so a resent request runs once. */
export const DEDUPE_MS = 5 * 60_000
export const PAIR_TTL_MS = 2 * 60_000
/** Window focus sends `refresh` to a machine at most this often. */
export const REFRESH_MIN_MS = 10_000
export const DEFAULT_GRACE_SECONDS = 120

export type ByeReason = 'sleep' | 'quit' | 'disconnect' | 'revoke'

export interface Hello {
  protocol: number
  appVersion: string
  machineId: string
  machineName: string
  platform: string
  capabilities: { terminals: boolean }
}

export type Frame =
  | ({ t: 'hello' } & Hello)
  | { t: 'snapshot'; snapshot: AppSnapshot; seq: number }
  | { t: 'snapshotRequest' }
  | { t: 'invoke'; id: string; method: string; args: unknown[] }
  /** seq: the last event the value reflects (snapshot-like replies). */
  | { t: 'result'; id: string; ok: boolean; value?: unknown; error?: string; seq?: number }
  | { t: 'event'; seq: number; event: MainEvent }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'bye'; reason: ByeReason }
  | { t: 'refresh' }
  | { t: 'health'; health: MachineHealth }
  /** Pairing connection only: one side's user accepted or rejected the code. */
  | { t: 'pairDecision'; accept: boolean }
  /** Pairing connection only, orchestrator → machine: both accepted and the orchestrator pinned the machine. */
  | { t: 'paired' }

// ---------- which request goes where ----------

/** Allowed from a controlled machine's own window: they only read. */
export const READ_METHODS = new Set(['snapshot', 'transcript', 'gitStats', 'gitFileDiff', 'readSkill', 'readClaudeMd', 'asset', 'openAsset'])

/** Never routed to a remote machine. */
export const PC_ONLY = new Set(['refreshUsage', 'micAccess', 'refineDictation', 'dictationLanguage', 'moveNode'])

/**
 * Requests that name nothing a machine owns take an explicit, optional machineId at this argument
 * index (missing means this machine). The link removes it before forwarding.
 */
export const MACHINE_ARG: Record<string, number> = {
  addProject: 1,
  setDefaultModel: 1,
  setModelEffort: 2,
  refreshConfig: 0,
  ghLogin: 0,
  setAutoApprove: 1,
  termStart: 4,
  remoteBrowse: 0
}

/** Requests with no timeout: they wait on long work or on a person. */
export const NO_TIMEOUT = new Set(['loopStart', 'refreshConfig', 'listFolders'])

/** Methods only the link serves on a remote machine (not part of the window's API there). */
export const LINK_METHODS = new Set(['listFolders', 'fetchArtifact', 'fetchAsset'])

/** Largest file sent over the link: base64 adds a third, and a frame holds 32 MB. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

// ---------- IDs ----------

/** A remote ID as the orchestrator's renderer sees it. */
export function withMachine(machineId: string, id: string): string {
  return `@${machineId}/${id}`
}

export function splitMachine(id: string): { machineId: string; id: string } | null {
  const m = /^@([^/]+)\/(.*)$/s.exec(id)
  return m ? { machineId: m[1], id: m[2] } : null
}

/** IDs that repeat across machines (skills, MCP servers, the ~/.claude hub) and so get the prefix. */
export function repeatsAcrossMachines(id: string): boolean {
  return /^(skill|mcp|hub):/.test(id)
}

export const LOCAL_MACHINE_NODE = 'machine:local'
export const machineNodeId = (machineId: string) => `machine:${machineId}`

/** Terminals the orchestrator starts on a remote machine, kept apart from the machine's own. */
export const REMOTE_TERM_PREFIX = 'remote:'
