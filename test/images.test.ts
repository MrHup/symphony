// Images: the cut-out and sticker processing, the zip writer, the prompt, and the core's key handling and
// queue against a stand-in for the Gemini API (global fetch is replaced; nothing reaches Google).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, before, describe, test } from 'node:test'
import { flushAll, setDataDir } from '../src/main/store'
import type { ToolCore, ToolDeps } from '../src/main/tools'
import { imagesCore } from '../src/tools/images/core'
import { buildParts } from '../src/tools/images/gemini'
import { bounds, cutout, dieCut, nearestSeeds, removeWhite, STICKER_BORDER, trim, type Pixels } from '../src/tools/images/imaging'
import type { ImageDraft, ImagesState } from '../src/tools/images/types'
import { crc32, fileNames, zip } from '../src/tools/images/zip'

const dataDir = mkdtempSync(join(tmpdir(), 'symphony-images-test-'))
setDataDir(dataDir)

/** A white image with filled rectangles: [x, y, w, h, r, g, b]. */
function picture(w: number, h: number, rects: number[][]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (const [x0, y0, rw, rh, r, g, b] of rects) {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) data.set([r, g, b, 255], (y * w + x) * 4)
  }
  return { width: w, height: h, data }
}
const px = (p: Pixels, x: number, y: number) => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4))

describe('cut-outs and stickers', () => {
  test('nearest seeds match a brute-force search', () => {
    const w = 41
    const h = 37
    const seed = new Uint8Array(w * h)
    let s = 7
    for (let i = 0; i < seed.length; i++) seed[i] = (s = (s * 1103515245 + 12345) % 2147483648) % 23 === 0 ? 1 : 0
    const { dist2 } = nearestSeeds(seed, w, h)
    let worst = 0
    for (let i = 0; i < w * h; i++) {
      let best = Infinity
      for (let j = 0; j < w * h; j++) if (seed[j]) best = Math.min(best, ((i % w) - (j % w)) ** 2 + (((i / w) | 0) - ((j / w) | 0)) ** 2)
      worst = Math.max(worst, Math.sqrt(dist2[i]) - Math.sqrt(best))
    }
    assert.ok(worst < 0.5, `off by ${worst} px at most`)
  })

  test('white becomes transparent, the subject stays, edges keep their color', () => {
    // A red square, with a column of half-red (pink) pixels at its right edge, as anti-aliasing leaves.
    const img = picture(20, 20, [
      [5, 5, 8, 8, 200, 0, 0],
      [13, 5, 1, 8, 228, 128, 128]
    ])
    const out = removeWhite(img)
    assert.deepEqual(px(out, 0, 0)[3], 0, 'background is transparent')
    assert.deepEqual(px(out, 8, 8), [200, 0, 0, 255], 'inside is untouched')
    const [r, g, b, a] = px(out, 13, 8)
    assert.deepEqual([r, g, b], [200, 0, 0], 'the edge takes the solid color')
    assert.ok(Math.abs(a - 128) < 8, `the edge is half covered (alpha ${a})`)
    assert.deepEqual(bounds(out), { x: 5, y: 5, width: 9, height: 8 })
    assert.equal(trim(out).width, 9)
  })

  test('an image with nothing but white stays whole and empty', () => {
    const out = cutout(picture(8, 8, []))
    assert.equal(bounds(out.icon), null)
  })

  test('the sticker border follows the outline and fills enclosed gaps', () => {
    // A ring: a dark square with a white hole in the middle.
    const ring = trim(removeWhite(picture(120, 120, [[10, 10, 100, 100, 20, 20, 60]].concat([[40, 40, 40, 40, 255, 255, 255]]))))
    assert.equal(px(ring, 50, 50)[3], 0, 'the hole is transparent in the cut-out')
    const sticker = dieCut(ring)
    const border = Math.round(STICKER_BORDER * 100)
    const pad = border + 1
    assert.equal(sticker.width, 100 + 2 * pad)
    assert.deepEqual(px(sticker, pad + 50, pad + 50), [255, 255, 255, 255], 'the hole is filled with white')
    assert.deepEqual(px(sticker, pad - border + 1, pad + 50), [255, 255, 255, 255], 'the border is white')
    assert.equal(px(sticker, 0, pad + 50)[3], 0, 'outside the border is transparent')
    assert.deepEqual(px(sticker, pad + 5, pad + 5), [20, 20, 60, 255], 'the subject is on top')
  })
})

describe('zip', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  })

  test('entries can be read back from the central directory', () => {
    const files = [
      { name: 'cat.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'café.jpg', data: new Uint8Array(1000).fill(9) }
    ]
    const bytes = Buffer.concat(zip(files))
    const end = bytes.length - 22
    assert.equal(bytes.readUInt32LE(end), 0x06054b50)
    assert.equal(bytes.readUInt16LE(end + 10), 2)
    let at = bytes.readUInt32LE(end + 16)
    for (const f of files) {
      assert.equal(bytes.readUInt32LE(at), 0x02014b50)
      const size = bytes.readUInt32LE(at + 20)
      const nameLen = bytes.readUInt16LE(at + 28)
      const local = bytes.readUInt32LE(at + 42)
      assert.equal(bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8'), f.name)
      const data = bytes.subarray(local + 30 + bytes.readUInt16LE(local + 26), local + 30 + bytes.readUInt16LE(local + 26) + size)
      assert.deepEqual(new Uint8Array(data), f.data)
      assert.equal(bytes.readUInt32LE(at + 16), crc32(f.data))
      at += 46 + nameLen
    }
  })

  test('file names are safe and unique', () => {
    assert.deepEqual(
      fileNames([
        { name: 'A red Fox!', ext: 'png' },
        { name: 'a red fox', ext: 'jpg' },
        { name: '***', ext: 'png' }
      ]),
      ['a-red-fox.png', 'a-red-fox-2.jpg', 'image.png']
    )
  })
})

describe('prompt', () => {
  const text = (parts: ReturnType<typeof buildParts>) => (parts.at(-1) as { text: string }).text
  const ref = { mime: 'image/png', data: 'AAAA' }

  test('a plain image is the prompt, with the style before it', () => {
    assert.equal(text(buildParts({ prompt: 'a lighthouse', style: 'watercolor', kind: 'image', refRole: 'style' }, [])), 'Style: watercolor\n\na lighthouse')
  })

  test('an icon without a style gets the flat icon style and the cut-out rules', () => {
    const t = text(buildParts({ prompt: 'rocket', style: '', kind: 'icon', refRole: 'style' }, []))
    assert.match(t, /flat vector icon/)
    assert.match(t, /pure white/)
    assert.match(t, /Subject: rocket$/)
  })

  test('style references come first and the style adds to them', () => {
    const parts = buildParts({ prompt: 'rocket', style: 'thicker lines', kind: 'icon', refRole: 'style' }, [ref, ref])
    assert.equal(parts.length, 3)
    assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: 'AAAA' } })
    assert.match(text(parts), /^The attached images are a style reference only/)
    assert.doesNotMatch(text(parts), /flat vector/)
    assert.match(text(parts), /Additional style notes: thicker lines/)
  })

  test('without a prompt the style is the request', () => {
    assert.equal(text(buildParts({ prompt: '', style: 'a cat in a hat', kind: 'image', refRole: 'content' }, [ref])), 'Use the attached image as the input for the request below.\n\na cat in a hat')
  })
})

// ---------- the core, against a stand-in Gemini ----------

type Reply = { status: number; body: unknown }
let replies: (Reply | ((init: RequestInit) => Promise<Reply>))[] = []
const requests: { url: string; init: RequestInit }[] = []
const PNG = Buffer.from('fake png bytes').toString('base64')
const imageReply = (): Reply => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'thought' }, thought: true }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }] }
})

before(() => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const next = replies.shift()
    if (!next) throw new Error(`Unexpected request: ${url}`)
    const r = typeof next === 'function' ? await next(init) : next
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
})

afterEach(() => {
  replies = []
  requests.length = 0
})

function makeCore(): { core: ToolCore; state: () => ImagesState; changed: () => Promise<void> } {
  let wake: (() => void) | null = null
  const deps = {
    changed: () => {
      wake?.()
      wake = null
    }
  } as unknown as ToolDeps
  const core = imagesCore(deps)
  core.start()
  return { core, state: () => core.state() as ImagesState, changed: () => new Promise<void>((r) => (wake = r)) }
}

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const draft = (over: Partial<ImageDraft> = {}): ImageDraft => ({
  prompts: ['a fox'],
  style: '',
  kind: 'image',
  refRole: 'style',
  refs: [],
  model: 'gemini-3.1-flash-image',
  size: '512',
  aspect: '1:1',
  ...over
})

describe('core', () => {
  test('without a key nothing can be made', async () => {
    const { core, state } = makeCore()
    assert.deepEqual(state().key, { source: null })
    await assert.rejects(core.call('generate', [draft()]), /Set a Gemini API key first/)
  })

  test('the environment key is used and shown by its last four characters', () => {
    process.env.GEMINI_API_KEY = 'env-key-1234'
    try {
      const { state } = makeCore()
      assert.deepEqual(state().key, { source: 'env', env: 'GEMINI_API_KEY', hint: '1234' })
    } finally {
      delete process.env.GEMINI_API_KEY
    }
  })

  test('a key Gemini refuses is not saved', async () => {
    const { core, state } = makeCore()
    replies.push({ status: 400, body: { error: { message: 'API key not valid.' } } })
    await assert.rejects(core.call('setKey', ['bad-key']), /did not accept the key: API key not valid/)
    assert.equal(state().key.source, null)
    assert.equal((requests[0].init.headers as Record<string, string>)['x-goog-api-key'], 'bad-key')
  })

  test('a saved key is checked, kept sealed, and never in the state', async () => {
    const { core, state } = makeCore()
    replies.push({ status: 200, body: { models: [] } })
    await core.call('setKey', ['  secret-key-abcd  '])
    assert.deepEqual(state().key, { source: 'saved', hint: 'abcd' })
    assert.doesNotMatch(JSON.stringify(state()), /secret-key/)
    assert.doesNotMatch(readFileSync(join(dataDir, 'tools/images/key.json'), 'utf8'), /secret-key/)
    // A new core (a restart) still has it.
    assert.deepEqual(makeCore().state().key, { source: 'saved', hint: 'abcd' })
  })

  test('one image per prompt; the answer image is kept, not the thought', async () => {
    const { core, state } = makeCore()
    replies.push(imageReply(), imageReply())
    const ids = (await core.call('generate', [draft({ prompts: ['a fox', '', 'an owl'], aspect: '16:9' })])) as string[]
    assert.equal(ids.length, 2)
    await until(() => state().images.every((x) => x.status === 'done'))
    assert.deepEqual(
      state().images.map((x) => x.prompt),
      ['a fox', 'an owl']
    )
    const req = JSON.parse(String(requests[0].init.body))
    assert.match(requests[0].url, /models\/gemini-3\.1-flash-image:generateContent$/)
    assert.deepEqual(req.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '512' } })
    assert.equal((requests[0].init.headers as Record<string, string>)['x-goog-api-key'], 'secret-key-abcd')
    const got = (await core.call('getImage', [ids[0]])) as { mime: string; data: string }
    assert.deepEqual(got, { file: state().images[0].file, mime: 'image/png', data: PNG })
  })

  test('icons are square whatever aspect was picked', async () => {
    const { core, state } = makeCore()
    replies.push(imageReply())
    const [id] = (await core.call('generate', [draft({ kind: 'icon', aspect: '16:9' })])) as string[]
    await until(() => state().images.find((x) => x.id === id)?.status === 'done')
    assert.equal(JSON.parse(String(requests[0].init.body)).generationConfig.imageConfig.aspectRatio, '1:1')
  })

  test('a rate limit is tried again; a refusal is shown on the image', async () => {
    const { core, state } = makeCore()
    replies.push({ status: 429, body: { error: { message: 'Resource exhausted' } } }, imageReply())
    const [ok] = (await core.call('generate', [draft()])) as string[]
    await until(() => state().images.find((x) => x.id === ok)?.status === 'done')
    assert.equal(requests.length, 2)
    replies.push({ status: 200, body: { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] } })
    const [refused] = (await core.call('generate', [draft()])) as string[]
    await until(() => state().images.find((x) => x.id === refused)?.status === 'error')
    assert.equal(state().images.find((x) => x.id === refused)?.error, 'No image returned (IMAGE_SAFETY)')
  })

  test('references are stored once and sent first; deleting the last image that uses them removes them', async () => {
    const { core, state } = makeCore()
    replies.push(imageReply(), imageReply())
    const ref = { mediaType: 'image/png', data: Buffer.from('reference').toString('base64') }
    const ids = (await core.call('generate', [draft({ prompts: ['a', 'b'], refs: [ref] })])) as string[]
    await until(() => state().images.filter((x) => ids.includes(x.id)).every((x) => x.status === 'done'))
    const refsDir = join(dataDir, 'tools/images/refs')
    assert.equal(readdirSync(refsDir).length, 1)
    assert.deepEqual(JSON.parse(String(requests[0].init.body)).contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: ref.data } })
    await core.call('delete', [ids])
    assert.equal(readdirSync(refsDir).length, 0)
    await assert.rejects(core.call('generate', [draft({ refs: [{ mediaType: 'image/gif', data: 'AAAA' }] })]), /PNG, JPG or WebP/)
  })

  test('making an image again with a new prompt replaces its file', async () => {
    const { core, state } = makeCore()
    replies.push(imageReply())
    const [id] = (await core.call('generate', [draft()])) as string[]
    await until(() => state().images.find((x) => x.id === id)?.status === 'done')
    const first = state().images.find((x) => x.id === id)!.file!
    replies.push(imageReply())
    await new Promise((r) => setTimeout(r, 5))
    await core.call('regenerate', [id, 'a grey wolf'])
    await until(() => state().images.find((x) => x.id === id)?.file !== first)
    assert.equal(state().images.find((x) => x.id === id)?.prompt, 'a grey wolf')
    await until(() => !existsSync(join(dataDir, 'tools/images/files', first)))
  })

  test('deleting an image while it is made stops it and keeps nothing', async () => {
    const { core, state } = makeCore()
    replies.push(
      (init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
    )
    const [id] = (await core.call('generate', [draft()])) as string[]
    await until(() => state().images.find((x) => x.id === id)?.status === 'working')
    await core.call('delete', [[id]])
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(state().images.find((x) => x.id === id), undefined)
  })

  test('after a restart, unfinished images are stopped, not made again', async () => {
    const { core } = makeCore()
    replies.push((init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    const [id] = (await core.call('generate', [draft()])) as string[]
    await flushAll()
    core.shutdown()
    const again = makeCore().state().images.find((x) => x.id === id)
    assert.equal(again?.status, 'error')
    assert.match(again?.error ?? '', /Stopped when Symphony closed/)
  })
})
