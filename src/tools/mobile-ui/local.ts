// Mobile UI where the user is: an HTTPS server that shows a recipe's preview on a phone on the same
// network, wherever the recipe lives. It runs only while a preview is open, listens only on this
// machine's local-network addresses, and answers only paths that start with an open preview's secret.
// The app's files and the phone's comments go through the same requests as the window's, so a recipe on
// a remote machine is relayed over the link and that machine opens no port.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import QRCode from 'qrcode'
import type { AppSnapshot, MainEvent } from '@shared/types'
import { lanAddresses } from '../../main/remote/orchestrator'
import { loadJson, saveJson } from '../../main/store'
import type { ToolLocal } from '../../main/tools'
import { authorityCert, serverCert } from './cert'
import { TOOL_DIR } from './core'
import { TOOL_ID, type MobileUiState, type PhoneComment, type Preview, type Recipe, type RecipeFile } from './types'

export const PREVIEW_PORT = 47822
const LINKS_FILE = 'tools/mobile-ui/links.json'
const MAX_BODY = 256 * 1024
const KEEPALIVE_MS = 25_000
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const SHELL: Record<string, string> = { 'shell.js': 'text/javascript; charset=utf-8', 'shell.css': 'text/css; charset=utf-8', 'sw.js': 'text/javascript; charset=utf-8' }

interface Open {
  machineId?: string
  recipeId: string
  /** The phones following this preview (server-sent events). */
  clients: Set<ServerResponse>
  /** What they were last sent. */
  last: string
  name: string
  /** The app's files as last fetched, by path, to skip unchanged ones. */
  files: Map<string, RecipeFile>
}

const keyOf = (machineId: string | undefined, recipeId: string) => `${machineId ?? 'local'}/${recipeId}`
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

export function mobileUiLocal(invoke: (method: string, args: unknown[]) => Promise<unknown>, port = PREVIEW_PORT): ToolLocal {
  /** Each recipe's secret, kept while its preview is open and across restarts, so an installed preview keeps working. */
  const links = loadJson<Record<string, string>>(LINKS_FILE, {})
  const open = new Map<string, Open>()
  const servers = new Map<string, Server>()
  let keepalive: NodeJS.Timeout | undefined

  const call = (o: Open, method: string, args: unknown[]) => invoke('toolCall', [TOOL_ID, method, args, o.machineId])

  const addresses = () => {
    const all = lanAddresses()
    const lan = all.filter((a) => a !== '127.0.0.1')
    return lan.length ? [...lan, '127.0.0.1'] : all
  }

  const describe = async (token: string, o: Open): Promise<Preview> => {
    const urls = [...servers.keys()].sort((a, b) => addresses().indexOf(a) - addresses().indexOf(b)).map((a) => `https://${a}:${port}/p/${token}/`)
    const qr = await QRCode.toString(urls[0], { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#131312', light: '#e9e5dc' } })
    return { machineId: o.machineId, recipeId: o.recipeId, urls, qr }
  }

  /** Tell the phones about the recipe: its version (they reload when it moves) and its sessions. */
  const push = (o: Open, data: object) => {
    const text = JSON.stringify(data)
    if (text === o.last) return
    o.last = text
    for (const res of o.clients) res.write(`data: ${text}\n\n`)
  }
  const pushRecipe = (o: Open, r: Recipe) => {
    o.name = r.name
    push(o, { name: r.name, version: r.version, sessions: r.sessions })
  }
  const pushState = (machineId: string | undefined, state: unknown) => {
    for (const o of open.values()) {
      if (o.machineId !== machineId) continue
      const r = (state as MobileUiState | undefined)?.recipes.find((x) => x.id === o.recipeId)
      if (r) pushRecipe(o, r)
    }
  }

  const listen = async () => {
    if (servers.size) return
    const addrs = addresses()
    const { key, cert } = await serverCert(addrs)
    const failures: string[] = []
    await Promise.all(
      addrs.map(
        (addr) =>
          new Promise<void>((resolve) => {
            const server = createServer({ key, cert }, (req, res) => void handle(req, res).catch((err) => fail(res, 500, (err as Error).message)))
            server.once('error', (err: NodeJS.ErrnoException) => {
              failures.push(err.code === 'EADDRINUSE' ? `Port ${port} is already in use on ${addr}.` : err.message)
              resolve()
            })
            server.listen(port, addr, () => {
              servers.set(addr, server)
              resolve()
            })
          })
      )
    )
    if (!servers.size) throw new Error(failures[0] ?? 'The preview server could not start.')
    keepalive = setInterval(() => {
      for (const o of open.values()) for (const res of o.clients) res.write(': keepalive\n\n')
    }, KEEPALIVE_MS)
  }

  const close = () => {
    clearInterval(keepalive)
    for (const s of servers.values()) {
      s.close()
      s.closeAllConnections()
    }
    servers.clear()
  }

  const stop = (machineId: string | undefined, recipeId: string) => {
    const key = keyOf(machineId, recipeId)
    const token = links[key]
    const o = token ? open.get(token) : undefined
    for (const res of o?.clients ?? []) res.end()
    if (token) open.delete(token)
    // The next preview gets a new link: a stopped one never works again.
    delete links[key]
    saveJson(LINKS_FILE, () => links)
    if (!open.size) close()
  }

  const fail = (res: ServerResponse, status: number, message = '') => {
    if (res.headersSent) return void res.end()
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }

  const send = (res: ServerResponse, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(200, { ...HEADERS, 'Content-Type': type, ...extra }).end(body)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/p\/([\w-]+)(\/.*)?$/.exec(new URL(req.url ?? '/', 'https://preview').pathname)
    const o = m ? open.get(m[1]) : undefined
    if (!m || !o) return fail(res, 404)
    if (!m[2]) return void res.writeHead(301, { ...HEADERS, Location: `/p/${m[1]}/` }).end()
    const path = decodeURIComponent(m[2].slice(1))
    if (req.method === 'POST' && path === 'comment') return comment(o, req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405)
    if (path === '' || path === 'index.html') {
      const html = await readFile(join(TOOL_DIR, 'phone', 'index.html'), 'utf8')
      return send(res, 'text/html; charset=utf-8', html.replaceAll('{{name}}', escape(o.name)))
    }
    if (SHELL[path]) return send(res, SHELL[path], await readFile(join(TOOL_DIR, 'phone', path)))
    if (path === 'manifest.webmanifest') return send(res, 'application/manifest+json', manifest(o.name))
    if (/^icon-\d+\.png$/.test(path)) return send(res, 'image/png', icon(Math.min(1024, Math.max(16, Number(path.slice(5, -4))))))
    if (path === 'symphony-preview.crt') return send(res, 'application/x-x509-ca-cert', await authorityCert(), { 'Content-Disposition': 'attachment; filename="symphony-preview.crt"' })
    if (path === 'events') return events(o, res)
    if (path.startsWith('app/')) return appFile(o, path.slice(4), req, res)
    return fail(res, 404)
  }

  /** Server-sent events: the recipe's state now, then whenever it changes. */
  async function events(o: Open, res: ServerResponse): Promise<void> {
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
    o.clients.add(res)
    res.on('close', () => o.clients.delete(res))
    try {
      o.last = ''
      pushRecipe(o, (await call(o, 'getRecipe', [o.recipeId])) as Recipe)
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
    }
  }

  /** A file of the app, from the recipe's machine; unchanged files are not sent again. */
  async function appFile(o: Open, rel: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cached = o.files.get(rel)
    let file: RecipeFile
    try {
      file = (await call(o, 'getFile', [o.recipeId, rel, cached?.etag])) as RecipeFile
    } catch (err) {
      return fail(res, /Not found/.test((err as Error).message) ? 404 : 502, (err as Error).message)
    }
    if (file.data === undefined) file = cached!
    else o.files.set(rel, file)
    const etag = `"${file.etag}"`
    const headers = { ...HEADERS, 'Cache-Control': 'no-cache', ETag: etag, 'Content-Type': file.type }
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end()
    res.writeHead(200, headers).end(Buffer.from(file.data!, 'base64'))
  }

  async function comment(o: Open, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return fail(res, 413)
      chunks.push(chunk as Buffer)
    }
    let c: PhoneComment
    try {
      c = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PhoneComment
    } catch {
      return fail(res, 400)
    }
    try {
      send(res, 'application/json', JSON.stringify(await call(o, 'comment', [o.recipeId, c])))
    } catch (err) {
      fail(res, 502, (err as Error).message)
    }
  }

  return {
    async call(method, args) {
      const machineId = (args[0] as string | null) ?? undefined
      const recipeId = String(args[1])
      switch (method) {
        case 'start': {
          const r = (await invoke('toolCall', [TOOL_ID, 'getRecipe', [recipeId], machineId])) as Recipe
          const key = keyOf(machineId, recipeId)
          links[key] ??= randomBytes(32).toString('base64url')
          saveJson(LINKS_FILE, () => links)
          const token = links[key]
          if (!open.has(token)) open.set(token, { machineId, recipeId, clients: new Set(), last: '', name: r.name, files: new Map() })
          try {
            await listen()
          } catch (err) {
            open.delete(token)
            throw err
          }
          return describe(token, open.get(token)!)
        }
        case 'stop':
          return stop(machineId, recipeId)
        case 'getPreviews':
          return Promise.all([...open].map(([token, o]) => describe(token, o)))
        default:
          throw new Error(`Unknown request: ${method}`)
      }
    },
    onEvent(e: MainEvent) {
      if (!open.size) return
      if (e.type === 'tool' && e.tool === TOOL_ID) pushState(e.machineId, e.state)
      else if (e.type === 'machine') pushState(e.machine.id, e.machine.tools?.[TOOL_ID])
      else if (e.type === 'snapshot') {
        const s: AppSnapshot = e.snapshot
        pushState(undefined, s.tools[TOOL_ID])
        for (const m of s.machines) pushState(m.id, m.tools?.[TOOL_ID])
      }
      // A deleted recipe's preview ends with it.
      if (e.type === 'tool' && e.tool === TOOL_ID) {
        for (const o of [...open.values()]) {
          if (o.machineId === e.machineId && !(e.state as MobileUiState).recipes.some((r) => r.id === o.recipeId)) stop(o.machineId, o.recipeId)
        }
      }
    },
    shutdown() {
      for (const o of open.values()) for (const res of o.clients) res.end()
      open.clear()
      close()
    }
  }
}

function manifest(name: string): string {
  return JSON.stringify({
    name,
    short_name: name.slice(0, 12),
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#131312',
    theme_color: '#131312',
    icons: [192, 512].map((n) => ({ src: `icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose: 'any' }))
  })
}

/** The home-screen icon: a bone ring on charcoal, like Symphony's glyphs. A plain RGB PNG. */
function icon(size: number): Buffer {
  const row = size * 3 + 1
  const raw = Buffer.alloc(row * size)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ring = Math.abs(Math.hypot(x - c, y - c) - size * 0.28) < size * 0.035
      raw.set(ring ? [0xe9, 0xe5, 0xdc] : [0x13, 0x13, 0x12], y * row + 1 + x * 3)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
