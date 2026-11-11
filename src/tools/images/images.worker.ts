// The panel's image worker: decodes a generated image and, for cut-outs and icons, makes the transparent
// version and the die-cut sticker, each framed to the generated size. Off the main thread, because a
// 4K image takes seconds.
import { cutout, type Pixels } from './imaging'

export type WorkerRequest = { id: number; blob: Blob; cut: boolean }

export interface Processed {
  width: number
  height: number
  /** The image as generated, or for cut-outs the transparent PNG. */
  image: Blob
  sticker?: Blob
  /** Small previews for the grid, as data URLs (the window's CSP allows no blob: images). */
  thumb: string
  stickerThumb?: string
}

export type WorkerReply = { id: number; ok: true; result: Processed } | { id: number; ok: false; message: string }

const THUMB_EDGE = 320
/** The space kept clear around a cut-out, relative to the frame's longest side (2 px at 256). */
const PADDING = 0.008

function toCanvas(px: Pixels): OffscreenCanvas {
  const canvas = new OffscreenCanvas(px.width, px.height)
  canvas.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0)
  return canvas
}

/** The content scaled to fill a width × height frame (minus the padding), centered. */
function frame(px: Pixels, width: number, height: number): OffscreenCanvas {
  const pad = Math.max(1, Math.round(PADDING * Math.max(width, height)))
  const scale = Math.min((width - 2 * pad) / px.width, (height - 2 * pad) / px.height)
  const w = Math.max(1, Math.round(px.width * scale))
  const h = Math.max(1, Math.round(px.height * scale))
  const out = new OffscreenCanvas(width, height)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(toCanvas(px), Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h)
  return out
}

async function thumb(source: CanvasImageSource & { width: number; height: number }, type: string): Promise<string> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(source.width, source.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return dataUrl(await canvas.convertToBlob({ type, quality: 0.85 }))
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

async function processImage(blob: Blob, cut: boolean): Promise<Processed> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { width, height } = bitmap
    if (!cut) return { width, height, image: blob, thumb: await thumb(bitmap, 'image/jpeg') }
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const raw = ctx.getImageData(0, 0, width, height)
    const { icon, sticker } = cutout({ width, height, data: raw.data })
    const iconCanvas = frame(icon, width, height)
    const stickerCanvas = frame(sticker, width, height)
    const [image, stickerBlob, iconThumb, stickerThumb] = await Promise.all([
      iconCanvas.convertToBlob({ type: 'image/png' }),
      stickerCanvas.convertToBlob({ type: 'image/png' }),
      thumb(iconCanvas, 'image/png'),
      thumb(stickerCanvas, 'image/png')
    ])
    return { width, height, image, sticker: stickerBlob, thumb: iconThumb, stickerThumb }
  } finally {
    bitmap.close()
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, blob, cut } = e.data
  try {
    const result = await processImage(blob, cut)
    self.postMessage({ id, ok: true, result } satisfies WorkerReply)
  } catch (err) {
    self.postMessage({ id, ok: false, message: (err as Error).message || 'The image could not be read.' } satisfies WorkerReply)
  }
}
