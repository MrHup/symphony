// Small JSON persistence in Electron's userData folder: the graph (projects, sessions, positions)
// in one file and each session's transcript in its own file.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EffortLevel, LoopInfo, Point, Project, SessionInfo, TranscriptItem } from '@shared/types'

export interface PersistedState {
  projects: Project[]
  sessions: SessionInfo[]
  hubPosition: Point
  defaultModel: string
  efforts: Record<string, EffortLevel>
  loops: LoopInfo[]
}

const dir = () => app.getPath('userData')
const stateFile = () => join(dir(), 'symphony-state.json')
const transcriptDir = () => join(dir(), 'transcripts')
const transcriptFile = (id: string) => join(transcriptDir(), `${id.replace(/[^\w-]/g, '_')}.json`)

export function loadState(): PersistedState {
  const fallback: PersistedState = { projects: [], sessions: [], hubPosition: { x: -420, y: 0 }, defaultModel: 'opus', efforts: {}, loops: [] }
  try {
    return { ...fallback, ...JSON.parse(readFileSync(stateFile(), 'utf8')) }
  } catch {
    return fallback
  }
}

const timers = new Map<string, NodeJS.Timeout>()

function debounced(key: string, fn: () => Promise<void>, ms = 400): void {
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      fn().catch((err) => console.error('[store]', key, err))
    }, ms)
  )
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
