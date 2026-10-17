// Screenshots of a recipe's app in a headless browser at a phone's size. The app's files reach the page
// through Playwright's request routing, so nothing listens on the network. The browser is the Chrome or
// Edge installed on the machine (or SYMPHONY_BROWSER), since playwright-core ships none.
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'

/** The size recipes are designed and captured at (CSS pixels). */
export const PHONE = { width: 390, height: 844 }
const ORIGIN = 'http://recipe.invalid'
const SETTLE_MS = 300

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8'
}

export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

/** A path inside `root`, or null when it would leave it. */
export function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  const r = relative(root, full)
  return r && !r.startsWith('..') && !isAbsolute(r) ? full : null
}

export interface Shot {
  /** The app's route, e.g. "#/home?state=empty". */
  route: string
  /** Outlined in the picture, e.g. the element a comment is about. */
  selector?: string
}

export interface Captured {
  png: Buffer
  /** A small JPEG of the same view, with `thumb`. */
  thumb?: Buffer
  /** Errors the page reported while loading, for the session to fix. */
  errors: string[]
}

let channel: string | undefined

async function launch(): Promise<Browser> {
  if (process.env.SYMPHONY_BROWSER) return chromium.launch({ executablePath: process.env.SYMPHONY_BROWSER })
  for (const c of channel ? [channel] : ['chrome', 'msedge', 'chromium']) {
    try {
      const browser = await chromium.launch({ channel: c })
      channel = c
      return browser
    } catch {
      // Not installed; try the next one.
    }
  }
  throw new Error('Screenshots need Google Chrome or Microsoft Edge on this machine, or SYMPHONY_BROWSER set to a Chromium-based browser.')
}

/** One picture per shot of the app in `appDir`, at the phone's size. */
export async function capture(appDir: string, shots: Shot[], opts: { width?: number; height?: number; scale?: number; thumb?: boolean } = {}): Promise<Captured[]> {
  const browser = await launch()
  try {
    const context = await browser.newContext({
      viewport: { width: opts.width ?? PHONE.width, height: opts.height ?? PHONE.height },
      deviceScaleFactor: opts.scale ?? 2,
      isMobile: true,
      hasTouch: true
    })
    await context.route(`${ORIGIN}/**`, async (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1))
      const file = inside(appDir, path || 'index.html')
      const body = file ? await readFile(file).catch(() => null) : null
      if (!body) return route.fulfill({ status: 404, body: `Not found: ${path}` })
      return route.fulfill({ status: 200, body, contentType: contentType(file!) })
    })
    // Nothing else is reachable: a recipe works offline.
    await context.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort())
    const out: Captured[] = []
    for (const shot of shots) {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      await page.goto(`${ORIGIN}/index.html${shot.route.startsWith('#') ? shot.route : `#${shot.route}`}`, { waitUntil: 'load' })
      await page.evaluate('document.fonts.ready.then(() => undefined)')
      await page.waitForTimeout(SETTLE_MS)
      if (shot.selector) {
        const outline = `(() => {
          const el = document.querySelector(${JSON.stringify(shot.selector)})
          if (!el) return
          el.scrollIntoView({ block: 'center' })
          el.style.outline = '3px solid #ff6a13'
          el.style.outlineOffset = '2px'
        })()`
        await page.evaluate(outline).catch(() => undefined)
      }
      const png = await page.screenshot({ animations: 'disabled' })
      const thumb = opts.thumb ? await page.screenshot({ animations: 'disabled', type: 'jpeg', quality: 60, scale: 'css' }) : undefined
      out.push({ png, thumb, errors: [...new Set(errors)] })
      await page.close()
    }
    return out
  } finally {
    await browser.close()
  }
}
