// Small JSON persistence in the app's data folder (Electron's userData, set at startup): the graph
// (projects, sessions, positions) in one file and each session's transcript in its own file.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { EffortLevel, LoopInfo, Note, MachineColor, Point, Project, SessionInfo, TranscriptItem } from '@shared/types'

export interface PersistedState {
  projects: Project[]
  sessions: SessionInfo[]
  hubPosition: Point
  defaultModel: string
  efforts: Record<string, EffortLevel>
  optimizePrompts: boolean
  loops: LoopInfo[]
  notes: Note[]
  /** This machine's own node, shown once remote machines exist. */
  machinePosition?: Point
  /** Positions of remote nodes on this machine's graph, by machine id, then node id. */
  remoteLayout: Record<string, Record<string, Point>>
  /** Glyph colors of machines on this machine's graph, by machine id ('local' for this one). */
  machineColors: Record<string, MachineColor>
}

let dataDir = ''

/** Where everything is stored; called once at startup, before anything is read. */
export function setDataDir(dir: string): void {
  dataDir = dir
}

const dir = () => dataDir

/** A path inside the data folder. */
export const dataPath = (rel: string) => join(dataDir, rel)
const stateFile = () => join(dir(), 'symphony-state.json')
const transcriptDir = () => join(dir(), 'transcripts')
const transcriptFile = (id: string) => join(transcriptDir(), `${id.replace(/[^\w-]/g, '_')}.json`)

export function loadState(): PersistedState {
  const fallback: PersistedState = { projects: [], sessions: [], hubPosition: { x: -420, y: 0 }, defaultModel: 'opus', efforts: {}, optimizePrompts: true, loops: [], notes: [], remoteLayout: {}, machineColors: {} }
  try {
    return { ...fallback, ...JSON.parse(readFileSync(stateFile(), 'utf8')) }
  } catch {
    return fallback
  }
}

const timers = new Map<string, NodeJS.Timeout>()
const flushes = new Map<string, () => Promise<void>>()

function debounced(key: string, fn: () => Promise<void>, ms = 400): void {
  clearTimeout(timers.get(key))
  flushes.set(key, fn)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      flushes.delete(key)
      fn().catch((err) => console.error('[store]', key, err))
    }, ms)
  )
}

/** Write everything still waiting for its debounce, e.g. before quitting. */
export async function flushAll(): Promise<void> {
  const pending = [...flushes.entries()]
  for (const [key] of pending) clearTimeout(timers.get(key))
  timers.clear()
  flushes.clear()
  await Promise.all(pending.map(([key, fn]) => fn().catch((err) => console.error('[store]', key, err))))
}

export function saveState(state: PersistedState): void {
  debounced('state', () => writeFile(stateFile(), JSON.stringify(state, null, 2), 'utf8'))
}

export function loadTranscript(id: string): TranscriptItem[] {
  try {
    return JSON.parse(readFileSync(transcriptFile(id), 'utf8'))
  } catch {
    return []
  }
}

export function saveTranscript(id: string, items: TranscriptItem[]): void {
  if (!existsSync(transcriptDir())) mkdirSync(transcriptDir(), { recursive: true })
  debounced(`t:${id}`, () => writeFile(transcriptFile(id), JSON.stringify(items), 'utf8'), 1000)
}

export function deleteTranscript(id: string): void {
  clearTimeout(timers.get(`t:${id}`))
  void rm(transcriptFile(id), { force: true })
}

// ---------- other JSON files (remote orchestration) ----------

const dataFile = (rel: string) => join(dir(), rel)

export function loadJson<T>(rel: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(dataFile(rel), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Debounced write of `data()` (called when the write happens, so it sees the latest state). */
export function saveJson(rel: string, data: () => unknown, ms = 400): void {
  debounced(`j:${rel}`, async () => {
    const file = dataFile(rel)
    mkdirSync(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(data()), 'utf8')
  }, ms)
}

export function deleteJson(rel: string): void {
  clearTimeout(timers.get(`j:${rel}`))
  flushes.delete(`j:${rel}`)
  void rm(dataFile(rel), { force: true })
}

/** File names (without .json) in a data subfolder. */
export function listJson(sub: string): string[] {
  try {
    return readdirSync(dataFile(sub)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

export function appendLine(rel: string, line: string): void {
  const file = dataFile(rel)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${line}\n`, 'utf8')
}

export function readLines(rel: string): string[] {
  try {
    return readFileSync(dataFile(rel), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
