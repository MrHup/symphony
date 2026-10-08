// Files shown in a session (show_files, images a tool returned) or handed over between loop steps
// are copied here at that moment, named by the SHA-256 of their content. Transcripts and handoffs
// carry only a reference and a small preview, so they stay small, and what you review cannot change
// afterwards. An orchestrator keeps the files it fetched from remote machines in its own store.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { MAX_FILE_BYTES } from '@shared/remote'
import type { AssetRef, LoopInfo, TranscriptItem } from '@shared/types'

/** File types that can be shown: images inline, the rest opened in their default app. */
const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml'
}
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

/** Most files one show_files call or one handover takes. */
export const MAX_FILES = 20

export const mediaTypeOf = (path: string): string | null => MEDIA[extname(path).toLowerCase()] ?? null

/** The stored files a transcript refers to: files shown with show_files and images tools returned. */
export function assetIdsIn(items: TranscriptItem[]): string[] {
  return items.flatMap((i) => (i.kind === 'files' ? i.files : i.kind === 'tool' ? (i.result?.files ?? []) : []).map((f) => f.id))
}

/** The stored files a loop's handoffs refer to. */
export function assetIdsOfLoop(l: LoopInfo): string[] {
  return l.history.flatMap((h) => h.artifacts.flatMap((a) => (a.asset ? [a.asset.id] : [])))
}

export class AssetStore {
  /** Asset id → stored file name. */
  private index: Map<string, string> | null = null

  constructor(
    private dir: () => string,
    /** A small preview of a file as a data URL (Electron's nativeImage), or null. */
    private thumbnail: (path: string, mediaType: string) => Promise<string | null>
  ) {}

  private files(): Map<string, string> {
    if (this.index) return this.index
    this.index = new Map()
    try {
      for (const f of readdirSync(this.dir())) this.index.set(f.replace(/\.[^.]*$/, ''), f)
    } catch {
      // nothing stored yet
    }
    return this.index
  }

  /** The stored file, or null when this machine does not have it. */
  path(id: string): string | null {
    const f = /^[0-9a-f]{64}$/.test(id) ? this.files().get(id) : undefined
    return f ? join(this.dir(), f) : null
  }

  /** Copy a file into the store. Throws with a readable reason when it cannot be shown. */
  async storeFile(path: string): Promise<AssetRef> {
    const mediaType = mediaTypeOf(path)
    if (!mediaType) throw new Error(`${basename(path)} is not a file type that can be shown (images, PDFs, HTML, text).`)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new Error(`${path} does not exist.`)
    if (info.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} is too large (${Math.round(info.size / 1024 / 1024)} MB; the limit is 20 MB).`)
    return this.storeBuffer(await readFile(path), basename(path), mediaType, path)
  }

  async storeBuffer(data: Buffer, name: string, mediaType: string, from: string): Promise<AssetRef> {
    const id = createHash('sha256').update(data).digest('hex')
    const file = await this.put(id, extname(name) || EXT[mediaType] || '', data)
    return { id, name, mediaType, size: data.length, path: from, thumb: (await this.thumbnail(file, mediaType)) ?? undefined }
  }

  /** Keep a file fetched from another machine; it must match its id. */
  async putVerified(id: string, ext: string, data: Buffer): Promise<string> {
    if (createHash('sha256').update(data).digest('hex') !== id) throw new Error('The file arrived damaged (its checksum does not match).')
    return this.put(id, ext, data)
  }

  private async put(id: string, ext: string, data: Buffer): Promise<string> {
    const existing = this.path(id)
    if (existing) return existing
    mkdirSync(this.dir(), { recursive: true })
    const name = `${id}${ext.toLowerCase()}`
    await writeFile(join(this.dir(), name), data)
    this.files().set(id, name)
    return join(this.dir(), name)
  }

  ids(): string[] {
    return [...this.files().keys()]
  }

  /**
   * Delete the candidates nothing refers to any more. Files written in the last `minAgeMs` are
   * left alone (one may have just been stored for a transcript item not saved yet). Returns what
   * was deleted.
   */
  sweep(candidates: Iterable<string>, referenced: Set<string>, minAgeMs = 0): string[] {
    const removed: string[] = []
    for (const id of new Set(candidates)) {
      const path = this.path(id)
      if (!path || referenced.has(id)) continue
      try {
        if (minAgeMs && Date.now() - statSync(path).mtimeMs < minAgeMs) continue
        rmSync(path, { force: true })
        this.files().delete(id)
        removed.push(id)
      } catch (err) {
        console.error('[assets] could not delete', path, err)
      }
    }
    return removed
  }

  async read(id: string): Promise<{ data: Buffer; ext: string }> {
    const path = this.path(id)
    if (!path) throw new Error('That file is no longer stored.')
    return { data: await readFile(path), ext: extname(path) }
  }

  async dataUrl(id: string, mediaType?: string): Promise<string> {
    const { data, ext } = await this.read(id)
    return `data:${mediaType ?? MEDIA[ext] ?? 'application/octet-stream'};base64,${data.toString('base64')}`
  }

  /**
   * Store the files that paths name: files, folders (their viewable files) and `*` patterns in the
   * last part of a path. Relative paths are taken from `baseDir`. At most MAX_FILES.
   */
  async collect(baseDir: string, paths: string[]): Promise<{ files: AssetRef[]; skipped: string[] }> {
    const wanted: string[] = []
    const skipped: string[] = []
    for (const p of paths) {
      const full = isAbsolute(p) ? p : resolve(baseDir, p)
      if (/[*?]/.test(basename(full))) {
        const dir = dirname(full)
        const re = new RegExp(`^${basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
        const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).sort()
        if (!names.length) skipped.push(`${p} (no matching files)`)
        wanted.push(...names.map((n) => join(dir, n)))
      } else if (existsSync(full) && (await stat(full)).isDirectory()) {
        const names = (await readdir(full)).filter((n) => !n.startsWith('.') && mediaTypeOf(n)).sort()
        if (!names.length) skipped.push(`${p} (no viewable files in this folder)`)
        wanted.push(...names.map((n) => join(full, n)))
      } else wanted.push(full)
    }
    const unique = [...new Set(wanted)]
    const files: AssetRef[] = []
    for (const path of unique.slice(0, MAX_FILES)) {
      try {
        files.push(await this.storeFile(path))
      } catch (err) {
        skipped.push((err as Error).message)
      }
    }
    if (unique.length > MAX_FILES) skipped.push(`${unique.length - MAX_FILES} more files (at most ${MAX_FILES} at a time)`)
    return { files, skipped }
  }
}
