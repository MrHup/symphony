import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Dictation } from '../speech/dictation'

/** Tap to start dictating, tap again to stop. The arc means the take is being transcribed and cleaned up. */
export function MicButton({ d, size = 14 }: { d: Dictation; size?: number }) {
  const busy = d.state === 'finishing' || d.state === 'refining'
  const title =
    d.state === 'recording'
      ? d.loading !== null
        ? `Listening. Downloading the speech model (${d.loading}%), the text appears once it is ready. Click to stop.`
        : 'Listening. Click to stop.'
      : busy
        ? d.state === 'refining'
          ? 'Cleaning up the text…'
          : 'Transcribing…'
        : (d.error ?? 'Dictate')
  return (
    <button
      type="button"
      className={`icon-btn mic${d.state === 'recording' ? ' is-recording' : ''}${busy ? ' is-busy' : ''}`}
      title={title}
      aria-pressed={d.state === 'recording'}
      disabled={busy}
      onClick={d.toggle}
    >
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4.75" y="1.5" width="4.5" height="7" rx="2.25" fill={d.state === 'recording' ? 'currentColor' : 'none'} />
        <path d="M2.75 6.75a4.25 4.25 0 0 0 8.5 0M7 11v1.75" />
      </svg>
      {busy && (
        <svg className="mic-arc" width={size + 12} height={size + 12} viewBox="0 0 26 26" aria-hidden>
          <circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--bone)" strokeWidth="1" strokeLinecap="round" strokeDasharray="18 60" />
        </svg>
      )}
    </button>
  )
}

/** A one-line status under the field, only while the speech model downloads or after an error. */
export function DictationStatus({ d }: { d: Dictation }) {
  if (d.error) return <div className="dictation-status">{d.error}</div>
  if (d.state === 'recording' && d.loading !== null)
    return (
      <div className="dictation-status">
        {d.loading < 100 ? `Downloading the speech model, first use only (${d.loading}%)` : 'Preparing the speech model…'}
      </div>
    )
  return null
}

const MIRRORED: (keyof CSSStyleDeclaration)[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderLeftWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'textIndent',
  'wordSpacing',
  'tabSize'
]

/**
 * Drawn exactly over the text field while dictating: the text around the cursor at full strength
 * and the words heard so far at lower opacity. The field itself holds the same text, transparent.
 */
export function DictationOverlay({ d, area }: { d: Dictation; area: React.RefObject<HTMLTextAreaElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({})
  const active = d.state !== 'idle'

  useLayoutEffect(() => {
    const el = area.current
    if (!active || !el) return
    const cs = getComputedStyle(el)
    const s: Record<string, string> = {}
    for (const k of MIRRORED) s[k as string] = cs[k] as string
    setStyle({ ...s, top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight })
  }, [active, area, d.interim])

  useLayoutEffect(() => {
    const el = area.current
    if (ref.current && el) ref.current.scrollTop = el.scrollTop
  })

  if (!active) return null
  const { before, after, interim } = d
  const sepBefore = before && interim && !/\s$/.test(before) ? ' ' : ''
  const sepAfter = after && interim && !/^\s/.test(after) ? ' ' : ''
  return (
    <div ref={ref} className="dictation-overlay" style={style} aria-hidden>
      {before}
      {sepBefore}
      <span className="dictation-interim">{interim}</span>
      {sepAfter}
      {after}
    </div>
  )
}
