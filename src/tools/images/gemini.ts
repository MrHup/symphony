// The Gemini API calls: generateContent with an image response, and a key check. Plain fetch, no SDK.
import type { ImageItem } from './types'

export const API = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT_MS = 180_000
/** Transient failures (rate limits, overload) are tried this many times in all. */
const ATTEMPTS = 3
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

// Shared content goes first (references, instructions, style) so only the subject varies at the end;
// implicit caching can then apply if these models ever support it.
const STYLE_REF_INTRO = (noun: string, n: number) =>
  `${n > 1 ? 'The attached images are' : 'The attached image is'} a style reference only. Create a new ${noun} of the subject below in exactly the same style: same look, color palette, shapes, proportions and level of detail.`
const CONTENT_REF_INTRO = (n: number) => `Use the attached ${n > 1 ? 'images' : 'image'} as the input for the request below.`
const ICON_INTRO = 'Create a clean, modern flat vector icon of the subject below. Flat colors only: no outlines, strokes, gradients, shadows or text.'
/** White becomes transparent afterwards, so the subject must not use it. */
const CUTOUT_RULES =
  'One centered subject on a solid pure white (#FFFFFF) background, drawn as large as possible: it fills nearly the entire canvas with minimal margin, without being cropped. Use light gray instead of pure white for any white parts of the subject.'

export interface Ref {
  mime: string
  data: string
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } }

/** The request's parts: references first, then the instructions, the style and the subject. */
export function buildParts(item: Pick<ImageItem, 'prompt' | 'style' | 'kind' | 'refRole'>, refs: Ref[]): Part[] {
  const subject = item.prompt.trim()
  const style = item.style.trim()
  const styleRefs = refs.length > 0 && item.refRole === 'style'
  const text: string[] = []
  if (styleRefs) text.push(STYLE_REF_INTRO(item.kind === 'icon' ? 'icon' : 'image', refs.length))
  else if (refs.length) text.push(CONTENT_REF_INTRO(refs.length))
  // The flat icon style is only the default: references or a style description set the style instead.
  else if (item.kind === 'icon' && !style) text.push(ICON_INTRO)
  if (item.kind !== 'image') text.push(CUTOUT_RULES)
  // Without a subject, the style is the request itself.
  if (style) text.push(subject ? `${styleRefs ? 'Additional style notes' : 'Style'}: ${style}` : style)
  if (subject) text.push(item.kind === 'image' ? subject : `Subject: ${subject}`)
  return [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data } })), { text: text.join('\n\n') }]
}

export class GeminiError extends Error {}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return body?.error?.message || `Gemini answered ${res.status} ${res.statusText}`.trim()
}

/** One image from a model; retries rate limits and server errors. The result is base64. */
export async function generateImage(key: string, item: ImageItem, refs: Ref[], signal: AbortSignal): Promise<{ mime: string; data: string }> {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: buildParts(item, refs) }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      // Icons are square whatever the panel had picked.
      imageConfig: { aspectRatio: item.kind === 'icon' ? '1:1' : item.aspect, imageSize: item.size }
    }
  })
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/models/${encodeURIComponent(item.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    })
    if (!res.ok) {
      if (RETRY_STATUS.has(res.status) && attempt < ATTEMPTS) {
        await wait(1500 * 2 ** (attempt - 1), signal)
        continue
      }
      throw new GeminiError(await errorText(res))
    }
    return pickImage((await res.json()) as GenerateResponse)
  }
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; thought?: boolean }[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
}

/** The answer's image (not a thought's draft), or why there is none. */
export function pickImage(json: GenerateResponse): { mime: string; data: string } {
  const candidate = json.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    if (part.inlineData?.data && !part.thought) return { mime: part.inlineData.mimeType || 'image/png', data: part.inlineData.data }
  }
  const reason = candidate?.finishReason ?? json.promptFeedback?.blockReason
  throw new GeminiError(`No image returned (${reason ?? 'unknown reason'})`)
}

/** Null when Gemini accepts the key; otherwise what it said. */
export async function checkKey(key: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`${API}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    return `Could not reach Gemini: ${(err as Error).message}`
  }
  return res.ok ? null : errorText(res)
}
