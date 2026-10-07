import { useRef, type ReactNode } from 'react'
import { useStore, type Panel } from '../store'
import { IconClose } from './icons'

/** A draggable, resizable window floating over the graph. Drag by the header, resize from the corner. */
export function FloatingPanel({ panel, title, meta, actions, children }: { panel: Panel; title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { updatePanel, closePanel, raisePanel } = useStore.getState()
  const start = useRef<{ mx: number; my: number; x: number; y: number; w: number; h: number } | null>(null)

  const track = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, select, input, textarea')) return
    e.preventDefault()
    raisePanel(panel.id)
    start.current = { mx: e.clientX, my: e.clientY, x: panel.x, y: panel.y, w: panel.w, h: panel.h }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const s = start.current
      if (!s) return
      const dx = ev.clientX - s.mx
      const dy = ev.clientY - s.my
      if (mode === 'move') {
        updatePanel(panel.id, {
          x: Math.min(Math.max(s.x + dx, -s.w + 120), window.innerWidth - 120),
          y: Math.min(Math.max(s.y + dy, 0), window.innerHeight - 42)
        })
      } else {
        updatePanel(panel.id, { w: Math.max(320, s.w + dx), h: Math.max(180, s.h + dy) })
      }
    }
    const onUp = () => {
      start.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  return (
    <section
      className="panel"
      style={{ left: panel.x, top: panel.y, width: panel.w, height: panel.h, zIndex: panel.z }}
      onPointerDown={() => raisePanel(panel.id)}
      onKeyDown={(e) => {
        // Escape inside the editor belongs to Monaco (find widget etc.), and must not drop unsaved edits.
        if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as Element).closest('.monaco-editor, textarea, input')) closePanel(panel.id)
      }}
    >
      <header className="panel-head" onPointerDown={track('move')}>
        <div className="panel-title">
          <span className="main">{title}</span>
          {meta && <span className="meta">{meta}</span>}
        </div>
        {actions}
        <button className="icon-btn" title="Close" onClick={() => closePanel(panel.id)}>
          <IconClose />
        </button>
      </header>
      <div className="panel-body">{children}</div>
      <div className="panel-resize" onPointerDown={track('resize')} />
    </section>
  )
}
