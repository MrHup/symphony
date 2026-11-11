import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanError } from '../../renderer/src/components/Composer'
import { Glyph } from '../../renderer/src/components/Glyph'
import { IconClose, IconRefresh, IconTrash } from '../../renderer/src/components/icons'
import { useMachineChoices, type MachineChoice } from '../../renderer/src/components/ToolMenu'
import { api, useStore } from '../../renderer/src/store'
import ImagesWorker from './images.worker?worker'
import type { Processed, WorkerReply } from './images.worker'
import { modelInfo, TOOL_ID, type ImageItem, type ImagesState } from './types'
import { fileNames, zip } from './zip'

export const call = <T,>(method: string, args: unknown[], machineId?: string) => api.toolCall(TOOL_ID, method, args, machineId) as Promise<T>

/** An image with the machine it lives on. */
export interface Entry {
  item: ImageItem
  machine: MachineChoice
}

/** Every machine's images, newest first. */
export function useEntries(): Entry[] {
  const choices = useMachineChoices()
  const here = useStore((s) => s.tools[TOOL_ID]) as ImagesState | undefined
  const machines = useStore((s) => s.machines)
  const stateOf = (machineId?: string) => (machineId ? machines[machineId]?.tools?.[TOOL_ID] : here) as ImagesState | undefined
  return choices.flatMap((c) => (stateOf(c.machineId)?.images ?? []).map((item) => ({ item, machine: c }))).sort((a, b) => b.item.createdAt - a.item.createdAt)
}

/** What a download holds: the long edge in pixels (null for the size it was made at), and the sticker or not. */
export interface ExportOptions {
  edge: number | null
  sticker: boolean
}

export const EDGES = [null, 2048, 1024, 512, 256, 128]

const isCut = (item: ImageItem) => item.kind !== 'image'

// ---------- processing, once per generated file ----------

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve(p: Processed): void; reject(e: Error): void }>()
const cache = new Map<string, Promise<Processed>>()
const CACHE_SIZE = 150

function imagesWorker(): Worker {
  if (worker) return worker
  worker = new ImagesWorker()
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const w = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    if (e.data.ok) w?.resolve(e.data.result)
    else w?.reject(new Error(e.data.message))
  }
  return worker
}

const blobOf = (base64: string, type: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type })

/** The image's file from its machine, decoded, and for cut-outs made transparent with its sticker. */
export function processed(entry: Entry): Promise<Processed> {
  const { item, machine } = entry
  const key = `${machine.machineId ?? 'local'}/${item.file}`
  let p = cache.get(key)
  if (!p) {
    p = call<{ mime: string; data: string }>('getImage', [item.id], machine.machineId).then(
      ({ mime, data }) =>
        new Promise<Processed>((resolve, reject) => {
          const id = nextId++
          waiting.set(id, { resolve, reject })
          imagesWorker().postMessage({ id, blob: blobOf(data, mime), cut: isCut(item) })
        })
    )
    // A failed load is tried again next time.
    p.catch(() => cache.delete(key))
    cache.set(key, p)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }
  return p
}

function useProcessed(entry: Entry): { result?: Processed; error?: string } {
  const [state, setState] = useState<{ file?: string; result?: Processed; error?: string }>({})
  // While it is made again, the last version stays on show.
  const file = entry.item.file
  useEffect(() => {
    if (!file) return
    let live = true
    processed(entry).then(
      (result) => live && setState({ file, result }),
      (err) => live && setState({ file, error: cleanError(err) })
    )
    return () => void (live = false)
    // The file names the content: a new generation gets a new one.
  }, [file, entry.machine.machineId])
  return state.file === file ? state : {}
}

// ---------- downloads ----------

const extOf = (type: string) => (type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png')

/** The file a download holds, scaled down when the export asks for a smaller long edge. */
async function exportBlob(p: Processed, opts: ExportOptions): Promise<Blob> {
  const src = opts.sticker && p.sticker ? p.sticker : p.image
  const long = Math.max(p.width, p.height)
  if (!opts.edge || opts.edge >= long) return src
  const scale = opts.edge / long
  const bitmap = await createImageBitmap(src)
  try {
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(p.width * scale)), Math.max(1, Math.round(p.height * scale)))
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.convertToBlob({ type: src.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.92 })
  } finally {
    bitmap.close()
  }
}

/** Electron asks where to save it. */
function save(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

const label = (item: ImageItem) => item.prompt || item.style || 'image'

export async function downloadOne(entry: Entry, opts: ExportOptions): Promise<void> {
  const blob = await exportBlob(await processed(entry), opts)
  save(blob, fileNames([{ name: label(entry.item), ext: extOf(blob.type) }])[0])
}

/** Every finished image in one zip, named after its prompt. */
export async function downloadAll(entries: Entry[], opts: ExportOptions, progress: (done: number) => void): Promise<void> {
  const blobs: Blob[] = []
  for (const e of entries) {
    blobs.push(await exportBlob(await processed(e), opts))
    progress(blobs.length)
  }
  const names = fileNames(blobs.map((b, i) => ({ name: label(entries[i].item), ext: extOf(b.type) })))
  const files = await Promise.all(blobs.map(async (b, i) => ({ name: names[i], data: new Uint8Array(await b.arrayBuffer()) })))
  save(new Blob(zip(files) as BlobPart[], { type: 'application/zip' }), 'images.zip')
}

// ---------- grid ----------

export function ImageCard({ entry, opts, showMachine, onOpen }: { entry: Entry; opts: ExportOptions; showMachine: boolean; onOpen(): void }) {
  const { item, machine } = entry
  const { result, error: loadError } = useProcessed(entry)
  const [prompt, setPrompt] = useState(item.prompt)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setPrompt(item.prompt), [item.prompt])
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (err) => setError(cleanError(err)))
  const busy = item.status === 'queued' || item.status === 'working'
  const src = result && (opts.sticker && result.stickerThumb ? result.stickerThumb : result.thumb)
  const model = modelInfo(item.model)?.name ?? item.model
  const regenerate = () => run(call('regenerate', [item.id, prompt], machine.machineId))

  return (
    <div className={`img-card${busy ? ' is-busy' : ''}`}>
      <button className={`img-tile${isCut(item) ? ' is-cut' : ''}`} disabled={!result} onClick={onOpen} title={result ? 'Open' : undefined}>
        {src && <img src={src} alt={label(item)} draggable={false} />}
        {busy && (
          <span className="img-status">
            <Glyph status="working" size={14} />
            {item.status === 'queued' ? 'Queued' : 'Generating…'}
          </span>
        )}
        {!busy &&
          item.status === 'error' &&
          // Made before, then failed when made again: the last version stays, with why the new one is missing.
          (item.file ? (
            <span className="img-status img-status-error" title={item.error}>
              Not made again: {item.error}
            </span>
          ) : (
            <span className="img-error">{item.error}</span>
          ))}
        {!busy && item.status === 'done' && !result && <span className="img-status">{loadError ?? 'Loading…'}</span>}
      </button>
      <fieldset className="lock img-row" disabled={!!machine.lock} title={machine.lock ?? undefined}>
        <input
          className="img-prompt"
          value={prompt}
          placeholder={item.style ? 'Style only' : 'References only'}
          title={`${item.prompt || item.style}\n${model} · ${item.size} · ${item.aspect}${showMachine ? ` · ${machine.name}` : ''}\nEdit and press Enter to make it again`}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), regenerate())}
        />
        <button className="icon-btn" title="Make it again" onClick={regenerate}>
          <IconRefresh />
        </button>
        <button className="icon-btn" title="Download" disabled={!result} onClick={() => run(downloadOne(entry, opts))}>
          <IconDownload />
        </button>
        <button
          className={`icon-btn${armed ? ' is-armed' : ''}`}
          title={armed ? 'Click again to delete' : 'Delete'}
          onMouseLeave={() => setArmed(false)}
          onClick={() => (armed ? run(call('delete', [[item.id]], machine.machineId)) : setArmed(true))}
        >
          <IconTrash />
        </button>
      </fieldset>
      {showMachine && <span className="img-machine">{machine.name}</span>}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

export const IconDownload = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
  </svg>
)

// ---------- full-window viewer ----------

/** One image at a time over the whole window; arrows move between images, a click switches between fit and actual size. */
export function ImageViewer({ entries, index, opts, onIndex, onClose }: { entries: Entry[]; index: number; opts: ExportOptions; onIndex(i: number): void; onClose(): void }) {
  const entry = entries[index]
  const { result, error } = useProcessed(entry)
  const [src, setSrc] = useState<string | null>(null)
  const [actual, setActual] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const blob = result && (opts.sticker && result.sticker ? result.sticker : result.image)

  // The full image as a data URL (the window's CSP allows no blob: images).
  useEffect(() => {
    setSrc(null)
    setActual(false)
    setSaveError(null)
    if (!blob) return
    let live = true
    const reader = new FileReader()
    reader.onload = () => live && setSrc(String(reader.result))
    reader.readAsDataURL(blob)
    return () => void (live = false)
  }, [blob])

  useEffect(() => {
    const move = (d: number) => onIndex((index + d + entries.length) % entries.length)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') move(1)
      else if (e.key === 'ArrowLeft') move(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, entries.length, onIndex, onClose])

  const { item } = entry
  const many = entries.length > 1
  const move = (d: number) => onIndex((index + d + entries.length) % entries.length)
  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name img-viewer-name">{label(item)}</span>
        <span className="lightbox-meta">
          {modelInfo(item.model)?.name ?? item.model} · {item.size} · {result ? `${result.width}×${result.height}` : item.aspect}
          {many && ` · ${index + 1} of ${entries.length}`}
        </span>
        <span className="spacer" />
        {saveError && <span className="lightbox-meta">{saveError}</span>}
        <button className="btn small" disabled={!result} onClick={() => downloadOne(entry, opts).catch((err) => setSaveError(cleanError(err)))}>
          Download
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className={`lightbox-stage${actual ? ' is-actual' : ''}${isCut(item) ? ' img-checker' : ''}`}>
        {src ? (
          <img src={src} alt={label(item)} draggable={false} onClick={(e) => (e.stopPropagation(), setActual((a) => !a))} title={actual ? 'Click to fit' : 'Click for actual size'} />
        ) : (
          <span className="lightbox-meta">{error ?? 'Loading…'}</span>
        )}
      </div>
      {many && (
        <>
          <button className="lightbox-nav prev" title="Previous (←)" onClick={(e) => (e.stopPropagation(), move(-1))}>
            ‹
          </button>
          <button className="lightbox-nav next" title="Next (→)" onClick={(e) => (e.stopPropagation(), move(1))}>
            ›
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
