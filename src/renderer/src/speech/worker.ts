// Speech-to-text worker: Whisper running locally through Transformers.js. It runs on the GPU
// (WebGPU) when the machine has one, otherwise on the CPU (WebAssembly). The model is downloaded
// from Hugging Face on first use and cached; audio never leaves the machine.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

/** Multilingual, small enough for live transcription. */
export const SPEECH_MODEL = 'onnx-community/whisper-base'

// Serve the ONNX runtime from the app bundle instead of a CDN.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
env.allowLocalModels = false

export type WorkerRequest = { type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array; language: string }

export type WorkerReply =
  | { type: 'progress'; percent: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string }

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null
const post = (m: WorkerReply) => self.postMessage(m)

async function gpu(): Promise<{ ok: boolean; f16: boolean }> {
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }
    const adapter = await nav.gpu?.requestAdapter()
    return { ok: !!adapter, f16: !!adapter?.features.has('shader-f16') }
  } catch {
    return { ok: false, f16: false }
  }
}

function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  asr ??= (async () => {
    const { ok, f16 } = await gpu()
    const device = ok ? 'webgpu' : 'wasm'
    const dtype = ok
      ? f16
        ? { encoder_model: 'fp16', decoder_model_merged: 'fp16' }
        : { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' }
    // Download progress is reported per file; combine it into one percentage.
    const files = new Map<string, { loaded: number; total: number }>()
    const p = (await pipeline('automatic-speech-recognition', SPEECH_MODEL, {
      device,
      dtype: dtype as never,
      progress_callback: (info: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== 'progress' || !info.file || !info.total) return
        files.set(info.file, { loaded: info.loaded ?? 0, total: info.total })
        const all = [...files.values()]
        const percent = (100 * all.reduce((n, f) => n + f.loaded, 0)) / all.reduce((n, f) => n + f.total, 0)
        post({ type: 'progress', percent: Math.round(percent) })
      }
    })) as AutomaticSpeechRecognitionPipeline
    // Warm up so the first real transcription is not slowed by shader compilation.
    await p(new Float32Array(16_000), { language: 'english' } as never)
    post({ type: 'ready', device })
    return p
  })()
  asr.catch(() => (asr = null))
  return asr
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load()
      return
    }
    const p = await load()
    const t0 = performance.now()
    const run = (language: string) => p(msg.audio, { task: 'transcribe', language, chunk_length_s: 30, stride_length_s: 5 } as never)
    // A language name Whisper does not know falls back to English rather than failing the take.
    const out = await run(msg.language).catch((err) => (msg.language !== 'english' ? run('english') : Promise.reject(err)))
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim()
    post({ type: 'result', id: msg.id, text, ms: Math.round(performance.now() - t0) })
  } catch (err) {
    post({ type: 'error', id: msg.type === 'transcribe' ? msg.id : undefined, message: (err as Error).message })
  }
}
