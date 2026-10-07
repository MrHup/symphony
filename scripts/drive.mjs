// Drives the built app for manual/agent testing: launches Symphony through Playwright's Electron
// support and takes commands over HTTP, so the app keeps running between commands.
//
//   npm run build && node scripts/drive.mjs            (listens on 127.0.0.1:4777)
//   curl -s localhost:4777 -d '{"cmd":"ss","arg":"landing"}'
//
// Commands: ss <name> | eval <js> | click <selector> | rightclick <selector> | dblclick <selector> | drag <selector> <dx> <dy> | pasteimage <selector> <path>
//           hover <selector> | type <text> | press <key> | text [selector] | logs | quit
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const APP_DIR = resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || join(tmpdir(), 'symphony-shots')
const PORT = Number(process.env.DRIVE_PORT || 4777)
mkdirSync(SHOT_DIR, { recursive: true })

const logs = []
const childEnv = { ...process.env, SYMPHONY_USER_DATA: process.env.SYMPHONY_USER_DATA || join(tmpdir(), 'symphony-test-profile') }
delete childEnv.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  args: [APP_DIR],
  cwd: APP_DIR,
  // VS Code sets ELECTRON_RUN_AS_NODE for processes it spawns, which would start Electron as plain Node.
  env: childEnv,
  timeout: 60_000
})
app.process().stdout?.on('data', (d) => logs.push(String(d)))
app.process().stderr?.on('data', (d) => logs.push(String(d)))
const page = await app.firstWindow()
page.on('console', (m) => logs.push(`[renderer ${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[renderer error] ${e.message}`))
await page.waitForLoadState('domcontentloaded')
await page.setViewportSize?.({ width: 1480, height: 920 }).catch(() => {})

const commands = {
  async ss(name) {
    const file = join(SHOT_DIR, `${name || Date.now()}.png`)
    await page.screenshot({ path: file })
    return file
  },
  eval: async (expr) => JSON.stringify(await page.evaluate(expr), null, 1),
  click: async (sel) => (await page.locator(sel).first().click(), 'ok'),
  rightclick: async (sel) => (await page.locator(sel).first().click({ button: 'right' }), 'ok'),
  dblclick: async (sel) => (await page.locator(sel).first().dblclick(), 'ok'),
  // drag <selector> <dx> <dy>: press on the element's center, move by (dx, dy), release.
  async drag(arg) {
    const parts = arg.split(' ')
    const dy = parts.pop()
    const dx = parts.pop()
    const sel = parts.join(' ')
    const box = await page.locator(sel).first().boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + Number(dx), y + Number(dy), { steps: 12 })
    await page.mouse.up()
    return 'ok'
  },
  // pasteimage <selector> <path>: fire a paste event carrying an image file at an element. This is the
  // event Ctrl+V produces, without touching the system clipboard.
  async pasteimage(arg) {
    const parts = arg.split(' ')
    const file = parts.pop()
    const sel = parts.join(' ')
    const b64 = readFileSync(file).toString('base64')
    return page.evaluate(
      ({ sel, b64 }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
        const el = document.querySelector(sel)
        if (!el) return 'NOT_FOUND'
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        return 'pasted'
      },
      { sel, b64 }
    )
  },
  hover: async (sel) => (await page.locator(sel).first().hover(), 'ok'),
  type: async (text) => (await page.keyboard.type(text, { delay: 10 }), 'ok'),
  press: async (key) => (await page.keyboard.press(key), 'ok'),
  text: async (sel) => page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null),
  logs: async () => logs.splice(0).join('').slice(-20000),
  async quit() {
    setTimeout(async () => {
      await app.close().catch(() => {})
      process.exit(0)
    }, 50)
    return 'bye'
  }
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    try {
      const { cmd, arg } = JSON.parse(body || '{}')
      const fn = commands[cmd]
      res.end(fn ? String(await fn(arg)) : `unknown command: ${cmd}`)
    } catch (err) {
      res.end(`ERROR: ${err.message}`)
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`driver ready on ${PORT}; screenshots in ${SHOT_DIR}`))
