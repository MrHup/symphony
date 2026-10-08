import { useEffect, useState } from 'react'
import type { AssetRef } from '@shared/types'
import { api, useStore } from '../store'
import { cleanError } from './Composer'
import { IconClose, IconDoc } from './icons'

const isImage = (f: AssetRef) => f.mediaType.startsWith('image/')

const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Full images, by asset id: fetched once per window (a remote one crosses the link once). */
const loaded = new Map<string, Promise<string>>()

function load(ownerId: string, id: string): Promise<string> {
  let p = loaded.get(id)
  if (!p) {
    p = api.asset(ownerId, id)
    p.catch(() => loaded.delete(id))
    loaded.set(id, p)
    // Keep the most recent few; they are full-size images.
    if (loaded.size > 40) loaded.delete(loaded.keys().next().value!)
  }
  return p
}

function useFull(ownerId: string, file: AssetRef | undefined, wanted: boolean): { src: string | null; error: string | null } {
  const [state, setState] = useState<{ src: string | null; error: string | null }>({ src: null, error: null })
  useEffect(() => {
    if (!file || !wanted) return
    let live = true
    setState({ src: null, error: null })
    load(ownerId, file.id).then(
      (src) => live && setState({ src, error: null }),
      (err) => live && setState({ src: null, error: cleanError(err) })
    )
    return () => {
      live = false
    }
  }, [ownerId, file?.id, wanted])
  return state
}

/**
 * Files shown in a session or handed over in a loop. Images appear as thumbnails and open in the
 * viewer; PDFs and other files open in this machine's default app. `ownerId` is the session or
 * loop they belong to, which tells Symphony which machine has them.
 */
export function FileGallery({ ownerId, files, compact }: { ownerId: string; files: AssetRef[]; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const images = files.filter(isImage)
  const others = files.filter((f) => !isImage(f))
  return (
    <div className={`gallery${compact ? ' is-compact' : ''}`}>
      {images.length > 0 && (
        <div className="gallery-grid">
          {images.map((f, i) => (
            <Viewable key={`${f.id}:${i}`} className="gallery-item" title={`${f.path}\n${sizeText(f.size)}`} onOpen={() => useStore.getState().setLightbox({ ownerId, files: images, index: i })}>
              <Thumb ownerId={ownerId} file={f} />
              <span className="gallery-name">{f.name}</span>
            </Viewable>
          ))}
        </div>
      )}
      {others.map((f, i) => (
        <Viewable
          key={`${f.id}:${i}`}
          className="artifact"
          title={f.path}
          onOpen={() => {
            setError(null)
            api.openAsset(ownerId, f.id).then(setError, (err) => setError(cleanError(err)))
          }}
        >
          <span className="artifact-label">
            <IconDoc /> {f.name}
          </span>
          <span className="artifact-target">
            {f.mediaType} · {sizeText(f.size)} · opens in its app
          </span>
        </Viewable>
      ))}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

/**
 * Not a <button>: looking is allowed while actions are disabled (a read-only window, an offline
 * machine), and the disabled fieldset around a loop's review card would disable buttons inside it.
 */
function Viewable({ className, title, onOpen, children }: { className: string; title: string; onOpen: () => void; children: React.ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={className}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onOpen()
      }}
    >
      {children}
    </div>
  )
}

/** The stored preview, or the full image for types without one (GIF, WebP, SVG). */
function Thumb({ ownerId, file }: { ownerId: string; file: AssetRef }) {
  const full = useFull(ownerId, file, !file.thumb)
  const src = file.thumb ?? full.src
  return src ? <img src={src} alt={file.name} draggable={false} /> : <span className="gallery-missing">{full.error ? 'not available' : file.name}</span>
}

/** Full-window image viewer: arrows move between images, a click switches between fit and actual size. */
export function Lightbox() {
  const box = useStore((s) => s.lightbox)
  const [actual, setActual] = useState(false)
  const file = box ? box.files[box.index] : undefined
  const full = useFull(box?.ownerId ?? '', file, !!box)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    setActual(false)
    setOpenError(null)
  }, [file?.id])

  useEffect(() => {
    if (!box) return
    const move = (d: number) => useStore.getState().setLightbox({ ...box, index: (box.index + d + box.files.length) % box.files.length })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setLightbox(null)
      else if (e.key === 'ArrowRight') move(1)
      else if (e.key === 'ArrowLeft') move(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [box])

  if (!box || !file) return null
  const many = box.files.length > 1
  const move = (d: number) => useStore.getState().setLightbox({ ...box, index: (box.index + d + box.files.length) % box.files.length })
  return (
    <div className="lightbox" onClick={() => useStore.getState().setLightbox(null)}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{file.name}</span>
        <span className="lightbox-meta" title={file.path}>
          {file.path} · {sizeText(file.size)}
          {many && ` · ${box.index + 1} of ${box.files.length}`}
        </span>
        <span className="spacer" />
        {openError && <span className="lightbox-meta">{openError}</span>}
        <button className="btn small" onClick={() => api.openAsset(box.ownerId, file.id).then(setOpenError, (err) => setOpenError(cleanError(err)))}>
          Open in its app
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={() => useStore.getState().setLightbox(null)}>
          <IconClose />
        </button>
      </div>
      <div className={`lightbox-stage${actual ? ' is-actual' : ''}`}>
        {full.src ? (
          <img src={full.src} alt={file.name} draggable={false} onClick={(e) => (e.stopPropagation(), setActual((a) => !a))} title={actual ? 'Click to fit' : 'Click for actual size'} />
        ) : (
          <span className="lightbox-meta">{full.error ?? 'Loading…'}</span>
        )}
      </div>
      {many && (
        <>
          <button className="lightbox-nav prev" title="Previous (←)" onClick={(e) => (e.stopPropagation(), move(-1))}>
            ‹
          </button>
          <button className="lightbox-nav next" title="Next (→)" onClick={(e) => (e.stopPropagation(), move(1))}>
            ›
          </button>
        </>
      )}
    </div>
  )
}
