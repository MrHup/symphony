// Cut-outs and die-cut stickers on raw RGBA pixels (straight alpha), with no canvas, so they run in the
// panel's worker and in tests alike. A port of the Icon Generator's numpy/scipy version.

export interface Pixels {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, alpha not premultiplied. */
  data: Uint8ClampedArray
}

/** Largest per-channel distance from pure white that still counts as background. */
const WHITE_TOLERANCE = 12
/** The die-cut border's width, relative to the subject's longest side. */
export const STICKER_BORDER = 0.045

/**
 * For every pixel, the squared distance to the nearest seed pixel and that seed's index (-1 without
 * seeds). Two raster passes that pass nearest seeds between neighbors (8SSEDT): exact in nearly every
 * case, and in the rest off by a fraction of a pixel, which is all a border or an edge color needs.
 */
export function nearestSeeds(seed: Uint8Array, w: number, h: number): { dist2: Float64Array; index: Int32Array } {
  const n = w * h
  const sx = new Int32Array(n)
  const sy = new Int32Array(n)
  const dist2 = new Float64Array(n).fill(Infinity)
  const index = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (!seed[i]) continue
    sx[i] = i % w
    sy[i] = (i / w) | 0
    dist2[i] = 0
    index[i] = i
  }
  const take = (i: number, x: number, y: number, j: number) => {
    if (index[j] < 0) return
    const dx = x - sx[j]
    const dy = y - sy[j]
    const d = dx * dx + dy * dy
    if (d < dist2[i]) {
      dist2[i] = d
      index[i] = index[j]
      sx[i] = sx[j]
      sy[i] = sy[j]
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x > 0) take(i, x, y, i - 1)
      if (y > 0) {
        take(i, x, y, i - w)
        if (x > 0) take(i, x, y, i - w - 1)
        if (x < w - 1) take(i, x, y, i - w + 1)
      }
    }
    for (let x = w - 2; x >= 0; x--) take(y * w + x, x, y, y * w + x + 1)
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (x < w - 1) take(i, x, y, i + 1)
      if (y < h - 1) {
        take(i, x, y, i + w)
        if (x < w - 1) take(i, x, y, i + w + 1)
        if (x > 0) take(i, x, y, i + w - 1)
      }
    }
    for (let x = 1; x < w; x++) take(y * w + x, x, y, y * w + x - 1)
  }
  return { dist2, index }
}

/**
 * Near-white pixels become transparent, enclosed gaps included. Edge pixels are blends of a solid color
 * with white: each takes the nearest solid color, and its alpha is how much of that color it holds, so
 * there are no white halos.
 */
export function removeWhite(px: Pixels): Pixels {
  const { width: w, height: h } = px
  const n = w * h
  const src = px.data
  const out = new Uint8ClampedArray(n * 4)
  // Ink: how far each channel is from white, after flattening any transparency onto white.
  const ink = new Float32Array(n * 3)
  const bg = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3] / 255
    let max = 0
    for (let c = 0; c < 3; c++) {
      const v = (255 - src[i * 4 + c]) * a
      ink[i * 3 + c] = v
      if (v > max) max = v
    }
    bg[i] = max <= WHITE_TOLERANCE ? 1 : 0
  }
  // Edge: not background, but next to it (4-neighbors).
  const edge = new Uint8Array(n)
  const solid = new Uint8Array(n)
  let anySolid = false
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (bg[i]) continue
      if ((x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w])) edge[i] = 1
      else (solid[i] = 1), (anySolid = true)
    }
  }
  const nearest = anySolid ? nearestSeeds(solid, w, h).index : null
  for (let i = 0; i < n; i++) {
    let alpha = bg[i] ? 0 : 1
    let s = i
    if (edge[i] && nearest) {
      s = nearest[i]
      // pixel = coverage * color + (1 - coverage) * white, solved for coverage.
      let dot = 0
      let norm = 0
      for (let c = 0; c < 3; c++) {
        dot += ink[i * 3 + c] * ink[s * 3 + c]
        norm += ink[s * 3 + c] ** 2
      }
      alpha = Math.min(1, Math.max(0, dot / Math.max(norm, 1)))
    }
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(255 - ink[s * 3 + c])
    out[i * 4 + 3] = Math.round(alpha * 255)
  }
  return { width: w, height: h, data: out }
}

/** The smallest box around the visible pixels, or null when nothing is visible. */
export function bounds(px: Pixels): { x: number; y: number; width: number; height: number } | null {
  let x0 = px.width
  let y0 = px.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (!px.data[(y * px.width + x) * 4 + 3]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** Cropped to its visible pixels (unchanged when nothing is visible). */
export function trim(px: Pixels): Pixels {
  const b = bounds(px)
  if (!b || (b.width === px.width && b.height === px.height)) return px
  const data = new Uint8ClampedArray(b.width * b.height * 4)
  for (let y = 0; y < b.height; y++) {
    const from = ((b.y + y) * px.width + b.x) * 4
    data.set(px.data.subarray(from, from + b.width * 4), y * b.width * 4)
  }
  return { width: b.width, height: b.height, data }
}

/** A white border that follows the subject's outer silhouette, interior gaps filled. Grows the image by the border. */
export function dieCut(icon: Pixels): Pixels {
  const border = Math.max(1, Math.round(STICKER_BORDER * Math.max(icon.width, icon.height)))
  const pad = border + 1
  const w = icon.width + 2 * pad
  const h = icon.height + 2 * pad
  const n = w * h
  const shape = new Uint8Array(n)
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) shape[(y + pad) * w + x + pad] = icon.data[(y * icon.width + x) * 4 + 3] > 127 ? 1 : 0
  }
  // Fill holes: whatever outside the shape cannot be reached from the image's edge belongs to it.
  // Pixels are marked as they are pushed, so each is pushed once at most.
  const outside = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (i: number) => {
    if (outside[i] || shape[i]) return
    outside[i] = 1
    stack[top++] = i
  }
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x)
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1)
  while (top) {
    const i = stack[--top]
    const x = i % w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (i >= w) push(i - w)
    if (i < n - w) push(i + w)
  }
  for (let i = 0; i < n; i++) if (!outside[i]) shape[i] = 1
  const { dist2 } = nearestSeeds(shape, w, h)
  const data = new Uint8ClampedArray(n * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      // White sticker under the subject, anti-aliased at its edge, then the subject over it.
      const under = Math.min(1, Math.max(0, border + 0.5 - Math.sqrt(dist2[i])))
      const ix = x - pad
      const iy = y - pad
      const inside = ix >= 0 && iy >= 0 && ix < icon.width && iy < icon.height
      const j = (iy * icon.width + ix) * 4
      const a = inside ? icon.data[j + 3] / 255 : 0
      const total = a + under * (1 - a)
      for (let c = 0; c < 3; c++) data[i * 4 + c] = total ? Math.round(((inside ? icon.data[j + c] : 0) * a + 255 * under * (1 - a)) / total) : 0
      data[i * 4 + 3] = Math.round(total * 255)
    }
  }
  return { width: w, height: h, data }
}

/** The cut-out and its die-cut sticker, both cropped to their content. */
export function cutout(raw: Pixels): { icon: Pixels; sticker: Pixels } {
  const icon = trim(removeWhite(raw))
  return { icon, sticker: trim(dieCut(icon)) }
}
