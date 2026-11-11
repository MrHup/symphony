// Images on the machine it runs on: the Gemini key (sealed by the OS, or from the environment), a queue
// that generates up to four images at once, and the images and their reference images on disk.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_FRAME_BYTES } from '@shared/remote'
import { openSecret, sealSecret } from '../../main/platform'
import type { ToolCore, ToolDeps } from '../../main/tools'
import { dataPath, loadJson, saveJson } from '../../main/store'
import { checkKey, generateImage, type Ref } from './gemini'
import {
  ASPECTS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_REFS,
  MAX_STYLE_CHARS,
  modelInfo,
  type ImageDraft,
  type ImageItem,
  type ImagesState,
  type KeyStatus
} from './types'

const STATE_FILE = 'tools/images/images.json'
const KEY_FILE = 'tools/images/key.json'
const CONCURRENCY = 4
const ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
const REF_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
/** The most an image can be and still cross the link to another machine as base64 in one frame. */
const MAX_IMAGE_BYTES = Math.floor((MAX_FRAME_BYTES - 64 * 1024) * 0.75)

interface SavedKey {
  sealed: string
  hint: string
}

export function imagesCore(d: ToolDeps): ToolCore {
  let images: ImageItem[] = []
  let saved: SavedKey | null = null
  const queue: ImageItem[] = []
  const running = new Map<string, AbortController>()

  const filesDir = () => dataPath(join('tools', 'images', 'files'))
  const refsDir = () => dataPath(join('tools', 'images', 'refs'))
  const save = () => saveJson(STATE_FILE, () => images)
  const update = () => (save(), d.changed())
  const need = (id: string) => {
    const img = images.find((x) => x.id === id)
    if (!img) throw new Error('That image is gone.')
    return img
  }

  /** A key saved here wins over the environment, so the panel can replace a key set elsewhere. */
  const key = (): string | null => {
    if (saved) return openSecret(saved.sealed)
    for (const name of ENV_KEYS) if (process.env[name]?.trim()) return process.env[name]!.trim()
    return null
  }

  const keyStatus = (): KeyStatus => {
    if (saved) return { source: 'saved', hint: saved.hint }
    const env = ENV_KEYS.find((name) => process.env[name]?.trim())
    return env ? { source: 'env', env, hint: process.env[env]!.trim().slice(-4) } : { source: null }
  }

  const setKey = async (value: string) => {
    const k = String(value ?? '').trim()
    if (!k || /\s/.test(k)) throw new Error('Paste the key as it is, without spaces.')
    const problem = await checkKey(k)
    if (problem) throw new Error(`Gemini did not accept the key: ${problem}`)
    saved = { sealed: sealSecret(k), hint: k.slice(-4) }
    mkdirSync(dirname(dataPath(KEY_FILE)), { recursive: true })
    await writeFile(dataPath(KEY_FILE), JSON.stringify(saved), 'utf8')
    d.changed()
  }

  const removeKey = async () => {
    saved = null
    await rm(dataPath(KEY_FILE), { force: true })
    d.changed()
  }

  /** Reference images are kept by content, so a batch that reuses one stores it once. */
  const saveRef = async (ref: { mediaType: string; data: string }) => {
    const ext = REF_TYPES[ref.mediaType]
    if (!ext) throw new Error('References must be PNG, JPG or WebP images.')
    const bytes = Buffer.from(String(ref.data), 'base64')
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('A reference image is empty or too large.')
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${ext}`
    mkdirSync(refsDir(), { recursive: true })
    if (!existsSync(join(refsDir(), name))) await writeFile(join(refsDir(), name), bytes)
    return name
  }

  const readRef = async (name: string): Promise<Ref> => {
    const ext = name.split('.').pop()!
    const mime = Object.keys(REF_TYPES).find((t) => REF_TYPES[t] === ext) ?? 'image/png'
    try {
      return { mime, data: (await readFile(join(refsDir(), name))).toString('base64') }
    } catch {
      throw new Error('One of its reference images is no longer stored.')
    }
  }

  /** Files no image uses any more. */
  const sweep = async (files: (string | undefined)[], refs: string[]) => {
    const usedRefs = new Set(images.flatMap((x) => x.refs))
    await Promise.all([
      ...files.filter((f): f is string => !!f).map((f) => rm(join(filesDir(), f), { force: true })),
      ...refs.filter((r) => !usedRefs.has(r)).map((r) => rm(join(refsDir(), r), { force: true }))
    ])
  }

  const pump = () => {
    while (running.size < CONCURRENCY && queue.length) void generate(queue.shift()!)
  }

  const generate = async (img: ImageItem) => {
    const ctrl = new AbortController()
    running.set(img.id, ctrl)
    img.status = 'working'
    img.error = undefined
    update()
    try {
      const k = key()
      if (!k) throw new Error('Set a Gemini API key first.')
      const out = await generateImage(k, img, await Promise.all(img.refs.map(readRef)), ctrl.signal)
      const bytes = Buffer.from(out.data, 'base64')
      const ext = out.mime === 'image/jpeg' ? 'jpg' : out.mime === 'image/webp' ? 'webp' : 'png'
      const file = `${img.id}-${Date.now().toString(36)}.${ext}`
      if (ctrl.signal.aborted) return
      mkdirSync(filesDir(), { recursive: true })
      await writeFile(join(filesDir(), file), bytes)
      // Deleted or started again while it was being written.
      if (ctrl.signal.aborted || !images.includes(img)) return void rm(join(filesDir(), file), { force: true })
      const old = img.file
      Object.assign(img, { file, mime: out.mime, status: 'done' })
      void sweep([old], [])
    } catch (err) {
      if (ctrl.signal.aborted) return
      img.status = 'error'
      img.error = (err as Error).message
    } finally {
      if (running.get(img.id) === ctrl) running.delete(img.id)
      if (images.includes(img)) update()
      pump()
    }
  }

  const enqueue = (img: ImageItem) => {
    running.get(img.id)?.abort()
    running.delete(img.id)
    img.status = 'queued'
    img.error = undefined
    if (!queue.includes(img)) queue.push(img)
  }

  const create = async (draft: ImageDraft): Promise<string[]> => {
    if (!key()) throw new Error('Set a Gemini API key first.')
    const model = modelInfo(draft.model)
    if (!model) throw new Error(`Unknown model: ${draft.model}`)
    if (!model.sizes.includes(draft.size)) throw new Error(`${model.name} does not make ${draft.size} images.`)
    if (!ASPECTS.includes(draft.aspect)) throw new Error(`Unknown aspect ratio: ${draft.aspect}`)
    if (!['image', 'cutout', 'icon'].includes(draft.kind)) throw new Error(`Unknown kind: ${draft.kind}`)
    const style = String(draft.style ?? '').trim()
    const prompts = (draft.prompts ?? []).map((p) => String(p).trim()).filter(Boolean)
    const refs = draft.refs ?? []
    if (prompts.length > MAX_PROMPTS) throw new Error(`At most ${MAX_PROMPTS} prompts at once.`)
    if (prompts.some((p) => p.length > MAX_PROMPT_CHARS)) throw new Error(`Each prompt can be at most ${MAX_PROMPT_CHARS} characters.`)
    if (style.length > MAX_STYLE_CHARS) throw new Error(`The style can be at most ${MAX_STYLE_CHARS} characters.`)
    if (refs.length > MAX_REFS) throw new Error(`At most ${MAX_REFS} reference images.`)
    // No prompts: the style, the references or both make one image.
    if (!prompts.length && !style && !refs.length) throw new Error('Write a prompt, a style, or add a reference image.')
    const names = await Promise.all(refs.map(saveRef))
    const now = Date.now()
    const batch = (prompts.length ? prompts : ['']).map(
      (prompt, i): ImageItem => ({
        id: randomUUID(),
        prompt,
        style,
        kind: draft.kind,
        refRole: draft.refRole === 'content' ? 'content' : 'style',
        refs: names,
        model: model.id,
        size: draft.size,
        aspect: draft.kind === 'icon' ? '1:1' : draft.aspect,
        // Later prompts sort after earlier ones within the batch.
        createdAt: now - i,
        status: 'queued'
      })
    )
    images = [...batch, ...images]
    batch.forEach(enqueue)
    update()
    pump()
    return batch.map((x) => x.id)
  }

  /** Again with the same settings, optionally with a changed prompt. */
  const regenerate = (id: string, prompt?: string) => {
    const img = need(id)
    if (!key()) throw new Error('Set a Gemini API key first.')
    if (typeof prompt === 'string') {
      const p = prompt.trim()
      if (p.length > MAX_PROMPT_CHARS) throw new Error(`A prompt can be at most ${MAX_PROMPT_CHARS} characters.`)
      if (!p && !img.style && !img.refs.length) throw new Error('Write a prompt.')
      img.prompt = p
    }
    enqueue(img)
    update()
    pump()
  }

  const remove = async (ids: string[]) => {
    const gone = images.filter((x) => ids.includes(x.id))
    for (const img of gone) {
      running.get(img.id)?.abort()
      running.delete(img.id)
      const q = queue.indexOf(img)
      if (q >= 0) queue.splice(q, 1)
    }
    images = images.filter((x) => !gone.includes(x))
    update()
    await sweep(
      gone.map((x) => x.file),
      gone.flatMap((x) => x.refs)
    )
    pump()
  }

  /** An image's bytes, as base64. */
  const getImage = async (id: string) => {
    const img = need(id)
    if (!img.file) throw new Error('That image is not ready.')
    const bytes = await readFile(join(filesDir(), img.file)).catch(() => null)
    if (!bytes) throw new Error('That image is no longer stored.')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('That image is too large to send.')
    return { file: img.file, mime: img.mime ?? 'image/png', data: bytes.toString('base64') }
  }

  return {
    start() {
      saved = loadJson<SavedKey | null>(KEY_FILE, null)
      images = loadJson<ImageItem[]>(STATE_FILE, [])
      // Nothing runs across a restart: regenerating is the person's call, since every image costs money.
      for (const img of images) {
        if (img.status === 'queued' || img.status === 'working') Object.assign(img, { status: 'error', error: 'Stopped when Symphony closed. Regenerate to try again.' })
      }
    },
    state: (): ImagesState => ({ key: keyStatus(), images }),
    async call(method, args) {
      switch (method) {
        case 'setKey':
          return setKey(args[0] as string)
        case 'removeKey':
          return removeKey()
        case 'generate':
          return create(args[0] as ImageDraft)
        case 'regenerate':
          return regenerate(String(args[0]), args[1] === undefined ? undefined : String(args[1]))
        case 'delete':
          return remove((args[0] as unknown[]).map(String))
        case 'getImage':
          return getImage(String(args[0]))
        default:
          throw new Error(`Unknown request: ${method}`)
      }
    },
    shutdown() {
      for (const c of running.values()) c.abort()
    }
  }
}
