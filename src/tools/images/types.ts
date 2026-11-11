// Images types shared by the tool's core and its panel.

export const TOOL_ID = 'images'

export type ImageSize = '512' | '1K' | '2K' | '4K'

export interface ImageModel {
  id: string
  name: string
  /** Output sizes the model accepts, smallest first. */
  sizes: ImageSize[]
  /** US dollars per output image at each size (Gemini API pricing page, paid tier, October 2026). */
  price: Partial<Record<ImageSize, number>>
}

export const MODELS: ImageModel[] = [
  { id: 'gemini-3.1-flash-lite-image', name: 'Flash Lite', sizes: ['1K'], price: { '1K': 0.0336 } },
  { id: 'gemini-3.1-flash-image', name: 'Flash', sizes: ['512', '1K', '2K', '4K'], price: { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 } },
  { id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1', sizes: ['1K', '2K', '4K'], price: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 } },
  { id: 'gemini-3-pro-image', name: 'Pro', sizes: ['1K', '2K', '4K'], price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 } }
]

export const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

/**
 * image: kept as generated. cutout: one subject on white, made transparent and framed. icon: a cutout,
 * square, in a flat vector style unless references or a style say otherwise.
 */
export type ImageKind = 'image' | 'cutout' | 'icon'

/** What reference images are for: their style only, or the content the request works on. */
export type RefRole = 'style' | 'content'

export const MAX_REFS = 6
export const MAX_PROMPTS = 100
export const MAX_PROMPT_CHARS = 1000
export const MAX_STYLE_CHARS = 2000

export interface ImageItem {
  id: string
  /** One line of the prompts; empty when the style (and references) are the whole request. */
  prompt: string
  style: string
  kind: ImageKind
  refRole: RefRole
  /** Names of its reference images in the core's refs folder. */
  refs: string[]
  model: string
  size: ImageSize
  aspect: string
  createdAt: number
  status: 'queued' | 'working' | 'done' | 'error'
  error?: string
  /** The image's file in the core; a new name for every generation, so caches key on it. */
  file?: string
  mime?: string
}

/** Where the machine's Gemini key comes from. The key itself never leaves the core. */
export interface KeyStatus {
  source: 'saved' | 'env' | null
  /** The key's last four characters. */
  hint?: string
  /** The environment variable it came from. */
  env?: string
}

export interface ImagesState {
  key: KeyStatus
  /** Newest first. */
  images: ImageItem[]
}

/** What the panel sends to generate a batch: one image per prompt, all with the same settings. */
export interface ImageDraft {
  prompts: string[]
  style: string
  kind: ImageKind
  refRole: RefRole
  refs: { mediaType: string; data: string }[]
  model: string
  size: ImageSize
  aspect: string
}

export const modelInfo = (id: string) => MODELS.find((m) => m.id === id)
