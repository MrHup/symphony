// Dictation: record from the microphone, show a live transcript while the user speaks, then
// transcribe the whole take and have Claude (Haiku) clean it up.
import { useCallback, useEffect, useRef, useState } from 'react'
import workletUrl from './recorder-worklet.js?url'
import SpeechWorker from './worker?worker'
import type { WorkerReply } from './worker'

const RATE = 16_000
/** Re-transcribe the live window this often while recording. */
const LIVE_EVERY_MS = 1000
/** Whisper handles 30 s at a time; lock in text before a window gets that long. */
const WINDOW_S = 24
/** Below this loudness a window is treated as silence (Whisper invents text for silence). */
const SILENCE_RMS = 0.006

// ---------- one shared worker ----------

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()
const listeners = new Set<(r: WorkerReply) => void>()
let modelReady = false

function speechWorker(): Worker {
  if (worker) return worker
  worker = new SpeechWorker()
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const r = e.data
    if (r.type === 'ready') {
      modelReady = true
      console.info(`[speech] ${r.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'} ready`)
    }
    if (r.type === 'result') waiting.get(r.id)?.resolve(r.text)
    if (r.type === 'error' && r.id !== undefined) waiting.get(r.id)?.reject(new Error(r.message))
    if ((r.type === 'result' || r.type === 'error') && r.id !== undefined) waiting.delete(r.id)
    for (const l of listeners) l(r)
  }
  worker.postMessage({ type: 'load' })
  return worker
}

let language = 'english'

function transcribe(audio: Float32Array): Promise<string> {
  if (rms(audio) < SILENCE_RMS) return Promise.resolve('')
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    speechWorker().postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer])
  })
}

function rms(a: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i]
  return Math.sqrt(sum / Math.max(1, a.length))
}

const join = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(' ')

// ---------- recorder ----------

class Take {
  private chunks: Float32Array[] = []
  private length = 0
  private windowStart = 0
  private committed = ''
  private ctx?: AudioContext
  private stream?: MediaStream
  private timer?: number
  private busy: Promise<unknown> = Promise.resolve()
  private live = false

  constructor(private onInterim: (text: string) => void) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.ctx = new AudioContext({ sampleRate: RATE })
    await this.ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(this.ctx, 'symphony-recorder')
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data)
      this.length += e.data.length
    }
    this.ctx.createMediaStreamSource(this.stream).connect(node)
    this.timer = window.setInterval(() => void this.tick(), LIVE_EVERY_MS)
  }

  private samples(from: number): Float32Array {
    const out = new Float32Array(this.length - from)
    let offset = 0
    let pos = 0
    for (const c of this.chunks) {
      const end = pos + c.length
      if (end > from) {
        const s = Math.max(0, from - pos)
        out.set(c.subarray(s), offset)
        offset += c.length - s
      }
      pos = end
    }
    return out
  }

  /** Live preview: transcribe the current window; lock it in once it gets long. */
  private async tick(): Promise<void> {
    if (this.live || !modelReady || this.length - this.windowStart < RATE / 2) return
    this.live = true
    const end = this.length
    const job = transcribe(this.samples(this.windowStart).slice(0, end - this.windowStart))
    this.busy = job.catch(() => '')
    try {
      const text = await job
      if (end - this.windowStart >= WINDOW_S * RATE) {
        this.committed = join(this.committed, text)
        this.windowStart = end
        this.onInterim(this.committed)
      } else {
        this.onInterim(join(this.committed, text))
      }
    } catch {
      // keep the last preview
    } finally {
      this.live = false
    }
  }

  /** Stop recording and return the final transcript of the whole take. */
  async finish(): Promise<string> {
    window.clearInterval(this.timer)
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close().catch(() => undefined)
    await this.busy
    // Wait for the model if the take ended before it finished loading.
    await whenReady()
    const rest = this.samples(this.windowStart)
    return join(this.committed, rest.length ? await transcribe(rest) : '')
  }

  cancel(): void {
    window.clearInterval(this.timer)
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => undefined)
  }
}

function whenReady(): Promise<void> {
  if (modelReady) return Promise.resolve()
  speechWorker()
  return new Promise((resolve, reject) => {
    const l = (r: WorkerReply) => {
      if (r.type === 'ready') {
        listeners.delete(l)
        resolve()
      } else if (r.type === 'error' && r.id === undefined) {
        listeners.delete(l)
        reject(new Error(r.message))
      }
    }
    listeners.add(l)
  })
}

// ---------- hook ----------

export type DictationState = 'idle' | 'recording' | 'finishing' | 'refining'

export interface Dictation {
  state: DictationState
  /** Speech model loading: download percent (100 while warming up), null once ready. */
  loading: number | null
  error: string | null
  /** Text before and after the cursor when dictation started, and the words heard so far. */
  before: string
  interim: string
  after: string
  toggle(): void
  cancel(): void
}

/**
 * Dictation into a text field. While recording, the field shows the live transcript (rendered dimmed
 * by DictationOverlay); when the user stops, the cleaned-up text is inserted where the cursor was.
 */
export function useDictation(text: string, setText: (t: string) => void, area: React.RefObject<HTMLTextAreaElement | null>): Dictation {
  const [state, setState] = useState<DictationState>('idle')
  const [interim, setInterim] = useState('')
  const [loading, setLoading] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const take = useRef<Take | null>(null)
  const edges = useRef({ before: '', after: '' })
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    const l = (r: WorkerReply) => {
      // Stays set (100 = downloaded, warming up) until the model is ready.
      if (r.type === 'progress') setLoading((cur) => Math.max(cur ?? 0, r.percent))
      if (r.type === 'ready') setLoading(null)
      if (r.type === 'error' && r.id === undefined) setError(`Speech model failed to load: ${r.message}`)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
      take.current?.cancel()
    }
  }, [])

  const compose = useCallback(
    (middle: string) => {
      const { before, after } = edges.current
      const sepBefore = before && middle && !/\s$/.test(before) ? ' ' : ''
      const sepAfter = after && middle && !/^\s/.test(after) ? ' ' : ''
      return before + sepBefore + middle + sepAfter + after
    },
    []
  )

  const start = useCallback(async () => {
    setError(null)
    const el = area.current
    const t = textRef.current
    const at = el ? el.selectionStart : t.length
    const end = el ? el.selectionEnd : t.length
    edges.current = { before: t.slice(0, at), after: t.slice(end) }
    language = await window.symphony.dictationLanguage().catch(() => 'english')
    if (!(await window.symphony.micAccess())) {
      setError('Symphony has no access to the microphone.')
      return
    }
    if (!modelReady) setLoading((p) => p ?? 0)
    const rec = new Take((heard) => {
      setInterim(heard)
      setText(compose(heard))
    })
    try {
      speechWorker()
      await rec.start()
      take.current = rec
      setInterim('')
      setState('recording')
    } catch (err) {
      rec.cancel()
      setError(`Could not start the microphone: ${(err as Error).message}`)
    }
  }, [area, compose, setText])

  const stop = useCallback(async () => {
    const rec = take.current
    if (!rec) return
    take.current = null
    setState('finishing')
    try {
      const raw = await rec.finish()
      setInterim(raw)
      setText(compose(raw))
      if (!raw) {
        setState('idle')
        return
      }
      setState('refining')
      const refined = await window.symphony.refineDictation(raw).catch(() => raw)
      setText(compose(refined || raw))
      setInterim('')
    } catch (err) {
      setError(`Transcription failed: ${(err as Error).message}`)
    } finally {
      setState('idle')
      requestAnimationFrame(() => area.current?.focus())
    }
  }, [area, compose, setText])

  const toggle = useCallback(() => {
    if (state === 'idle') void start()
    else if (state === 'recording') void stop()
  }, [state, start, stop])

  const cancel = useCallback(() => {
    take.current?.cancel()
    take.current = null
    setText(compose(''))
    setInterim('')
    setState('idle')
  }, [compose, setText])

  return { state, loading, error, before: edges.current.before, interim, after: edges.current.after, toggle, cancel }
}
