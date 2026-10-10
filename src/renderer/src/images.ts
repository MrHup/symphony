// Pasted images: read from the clipboard, scaled to what Claude actually uses, with a thumbnail.
import { useCallback, useState } from 'react'
import type { ImageInput } from '@shared/types'

/** Claude scales images down to this long edge anyway; sending more only costs time and bytes. */
const MAX_EDGE = 1568
/** The API's limit is 5 MB of base64 per image, which is 3.75 MB of raw bytes. */
const MAX_BYTES = 3.75 * 1024 * 1024
const THUMB_EDGE = 160
const MAX_IMAGES = 20
const PASSTHROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function draw(bitmap: ImageBitmap, edge: number, type: string, quality?: number): Promise<Blob> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type, quality })
}

export async function readImage(file: Blob): Promise<ImageInput> {
  const bitmap = await createImageBitmap(file)
  try {
    const fits = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE
    let blob: Blob
    if (fits && PASSTHROUGH.has(file.type) && file.size <= MAX_BYTES) blob = file
    else {
      blob = await draw(bitmap, MAX_EDGE, 'image/png')
      if (blob.size > MAX_BYTES) blob = await draw(bitmap, MAX_EDGE, 'image/jpeg', 0.88)
    }
    const thumb = `data:image/jpeg;base64,${await base64(await draw(bitmap, THUMB_EDGE, 'image/jpeg', 0.8))}`
    return { mediaType: blob.type as ImageInput['mediaType'], data: await base64(blob), thumb }
  } finally {
    bitmap.close()
  }
}

/** Images pasted into a prompt box. Text pastes are left alone. */
export function usePastedImages() {
  const [images, setImages] = useState<ImageInput[]>([])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    void Promise.all(files.map((f) => readImage(f).catch(() => null))).then((read) => {
      const ok = read.filter((r): r is ImageInput => !!r)
      setImages((cur) => [...cur, ...ok].slice(0, MAX_IMAGES))
    })
  }, [])

  const remove = useCallback((index: number) => setImages((cur) => cur.filter((_, i) => i !== index)), [])
  const clear = useCallback(() => setImages([]), [])

  return { images, onPaste, remove, clear }
}
