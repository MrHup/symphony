import { useEffect, useMemo, useRef } from 'react'
import { clock, needsYou, useStore, type Panel } from '../store'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'

function useNeedsYou() {
  // Recomputed from the merged state; no request needed.
  const sessions = useStore((s) => s.sessions)
  const loops = useStore((s) => s.loops)
  const machines = useStore((s) => s.machines)
  const projects = useStore((s) => s.projects)
  const waitingSince = useStore((s) => s.waitingSince)
  return useMemo(() => needsYou(useStore.getState()), [sessions, loops, machines, projects, waitingSince])
}

/** The count in the dock: orange only when something waits for you. */
export function NeedsYouButton() {
  const items = useNeedsYou()
  const count = items.filter((i) => !i.offline).length
  return (
    <button
      className={`dock-btn needs-count${count ? ' is-waiting' : ''}`}
      title={`Needs you: ${items.length ? `${items.length} waiting` : 'nothing waiting'} (${window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+J opens the oldest)`}
      onClick={() => useStore.getState().openPanel('needs', 'all')}
    >
      {count}
    </button>
  )
}

export function NeedsYouPanel({ panel }: { panel: Panel }) {
  const items = useNeedsYou()
  return (
    <FloatingPanel panel={panel} title="Needs you" meta={`${items.length} waiting · oldest first`}>
      <div className="needs">
        {!items.length && <p className="remote-hint">Nothing is waiting for you.</p>}
        {items.map((i) => (
          <button key={i.key} className={`needs-row${i.offline ? ' is-offline' : ''}`} disabled={i.offline} title={i.offline ? `${i.machine} is offline; this can be answered once it is back` : undefined} onClick={i.open}>
            <Glyph status={i.offline ? 'idle' : 'input'} size={8} />
            <span className="needs-text">
              <span className="needs-summary">{i.summary}</span>
              <span className="needs-meta">
                {i.machine}
                {i.project && ` · ${i.project}`} · since {clock(i.since)}
                {i.offline && ' · offline'}
              </span>
            </span>
          </button>
        ))}
      </div>
    </FloatingPanel>
  )
}

/** Ctrl/⌘+J opens the panel of the oldest waiting item; pressing it again moves to the next. */
export function useNeedsYouShortcut(): void {
  const cursor = useRef<{ key: string; at: number } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'j') return
      e.preventDefault()
      const items = needsYou(useStore.getState()).filter((i) => !i.offline)
      if (!items.length) return
      // Within a few seconds of the last press, continue after the item opened then.
      const last = cursor.current && Date.now() - cursor.current.at < 8000 ? items.findIndex((i) => i.key === cursor.current!.key) : -1
      const next = items[(last + 1) % items.length]
      cursor.current = { key: next.key, at: Date.now() }
      next.open()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
