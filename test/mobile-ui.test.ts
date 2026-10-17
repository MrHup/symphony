// Mobile UI's phone preview: the server is off unless a preview is open, answers only paths that carry
// an open preview's secret, relays files and comments to the recipe's machine, and its certificate
// authority vouches for private addresses only.
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:https'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer as tlsServer } from 'node:tls'
import { after, before, describe, test } from 'node:test'
import { setDataDir } from '../src/main/store'
import { inside } from '../src/tools/mobile-ui/capture'
import { authorityCert, serverCert } from '../src/tools/mobile-ui/cert'
import { mobileUiLocal } from '../src/tools/mobile-ui/local'
import type { Preview, Recipe, RecipeFile } from '../src/tools/mobile-ui/types'

setDataDir(mkdtempSync(join(tmpdir(), 'symphony-mobile-ui-test-')))

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

let ca = ''

function get(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', ca, headers: opts.headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += String(d)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    sock.on('secureConnect', () => (sock.destroy(), resolve(false)))
    sock.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED'))
  })

/** The recipe's machine, as the preview server reaches it. */
function machine() {
  const calls: { method: string; args: unknown[]; machineId: unknown }[] = []
  const recipe = { id: 'r1', name: 'Demo', version: 1, sessions: [] } as unknown as Recipe
  const invoke = async (method: string, args: unknown[]) => {
    const [, toolMethod, toolArgs, machineId] = args as [string, string, unknown[], unknown]
    assert.equal(method, 'toolCall')
    calls.push({ method: toolMethod, args: toolArgs, machineId })
    if (toolMethod === 'getRecipe') return recipe
    if (toolMethod === 'comment') return { sessionId: 's1' }
    if (toolMethod === 'getFile') {
      const file: RecipeFile = { etag: 'e1', type: 'text/html; charset=utf-8' }
      return toolArgs[2] === 'e1' ? file : { ...file, data: Buffer.from('<p>app</p>').toString('base64') }
    }
    throw new Error(`unexpected ${toolMethod}`)
  }
  return { calls, invoke }
}

describe('phone preview', () => {
  let port = 0
  const m = machine()
  let local: ReturnType<typeof mobileUiLocal>

  before(async () => {
    port = await freePort()
    local = mobileUiLocal(m.invoke, port)
    ca = new X509Certificate(await authorityCert()).toString()
  })
  after(() => local.shutdown())

  test('the server listens only while a preview is open', async () => {
    assert.ok(await refused(port), 'off before any preview')
    const p = (await local.call('start', ['mac', 'r1'])) as Preview
    assert.match(p.urls[0], new RegExp(`^https://127\\.0\\.0\\.1:${port}/p/[\\w-]{43}/$`))
    assert.match(p.qr, /<svg/)
    assert.equal((await get(p.urls[0])).status, 200)
    await local.call('stop', ['mac', 'r1'])
    assert.ok(await refused(port), 'off again after the last preview stops')
  })

  test('only an open preview\'s secret is answered, and a stopped link never works again', async () => {
    const first = (await local.call('start', ['mac', 'r1'])) as Preview
    const origin = `https://127.0.0.1:${port}`
    assert.equal((await get(`${origin}/`)).status, 404)
    assert.equal((await get(`${origin}/p/${'x'.repeat(43)}/`)).status, 404)
    assert.equal((await get(`${origin}/app/index.html`)).status, 404)
    await local.call('start', ['local', 'other'])
    await local.call('stop', ['mac', 'r1'])
    const second = (await local.call('start', ['mac', 'r1'])) as Preview
    assert.notEqual(second.urls[0], first.urls[0])
    assert.equal((await get(first.urls[0])).status, 404)
    assert.equal((await get(second.urls[0])).status, 200)
    await local.call('stop', ['local', 'other'])
    await local.call('stop', ['mac', 'r1'])
  })

  test('files and comments go to the recipe\'s machine, and unchanged files are not sent again', async () => {
    const p = (await local.call('start', ['mac', 'r1'])) as Preview
    const first = await get(`${p.urls[0]}app/index.html`)
    assert.deepEqual([first.status, first.body], [200, '<p>app</p>'])
    assert.deepEqual(m.calls.at(-1), { method: 'getFile', args: ['r1', 'index.html', undefined], machineId: 'mac' })
    const again = await get(`${p.urls[0]}app/index.html`)
    assert.equal(again.body, '<p>app</p>', 'served from the copy here')
    assert.equal(m.calls.at(-1)!.args[2], 'e1', 'asked with the copy\'s etag')
    assert.equal((await get(`${p.urls[0]}app/index.html`, { headers: { 'If-None-Match': '"e1"' } })).status, 304)
    const sent = await get(`${p.urls[0]}comment`, { method: 'POST', body: JSON.stringify({ text: 'Bigger', route: '#/home' }) })
    assert.deepEqual(JSON.parse(sent.body), { sessionId: 's1' })
    assert.deepEqual(m.calls.at(-1), { method: 'comment', args: ['r1', { text: 'Bigger', route: '#/home' }], machineId: 'mac' })
    await local.call('stop', ['mac', 'r1'])
  })

  test('the authority vouches for private addresses only', async () => {
    const verify = async (address: string) => {
      const { key, cert } = await serverCert([address])
      const server = tlsServer({ key, cert })
      const tlsPort = await freePort()
      await new Promise<void>((r) => server.listen(tlsPort, '127.0.0.1', r))
      // The chain alone is checked here; the address itself is the phone's to compare.
      const result = await new Promise<string>((resolve) => {
        const sock = connect({ host: '127.0.0.1', port: tlsPort, ca, checkServerIdentity: () => undefined })
        sock.on('secureConnect', () => (sock.destroy(), resolve('trusted')))
        sock.on('error', (err) => resolve(err.message))
      })
      server.close()
      return result
    }
    assert.equal(await verify('192.168.1.20'), 'trusted')
    assert.equal(await verify('10.0.0.5'), 'trusted')
    assert.match(await verify('8.8.8.8'), /subtree/i)
  })

  test('a recipe file path cannot leave the app folder', () => {
    const app = join(tmpdir(), 'recipe', 'app')
    assert.equal(inside(app, 'screens/home.js'), join(app, 'screens', 'home.js'))
    assert.equal(inside(app, '../docs/RECIPE.md'), null)
    assert.equal(inside(app, 'a/../../../etc/passwd'), null)
    assert.equal(inside(app, ''), null)
  })
})
