import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, type Panel } from '../store'
import { TOOLS, toolTarget } from '../tools'

/** The bubble the tools button on a machine node opens: the tools that can run on that machine. */
export function ToolMenu() {
  const menu = useStore((s) => s.toolMenu)
  const name = useStore((s) => (!menu ? '' : menu.machineId === 'local' ? 'This PC' : (s.machines[menu.machineId]?.name ?? '')))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [side, setSide] = useState<'right' | 'left'>('right')

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const { width } = ref.current.getBoundingClientRect()
    const fitsRight = menu.right + 14 + width <= window.innerWidth - 16
    setSide(fitsRight ? 'right' : 'left')
    setPos({ left: fitsRight ? menu.right + 14 : Math.max(16, menu.left - 14 - width), top: Math.max(48, menu.top - 8) })
  }, [menu])

  // Escape or a click anywhere else closes it.
  useEffect(() => {
    if (!menu) return
    const close = () => useStore.getState().setToolMenu(null)
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null
  const machineId = menu.machineId === 'local' ? undefined : menu.machineId
  return (
    <div ref={ref} className={`composer tool-menu from-${side}`} style={pos}>
      <span className="color-menu-label">Tools on {name}</span>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className="tool-menu-item"
          onClick={() => {
            const s = useStore.getState()
            s.setToolMenu(null)
            s.openPanel('tool', toolTarget(t.id, machineId))
          }}
        >
          <span className="tool-menu-name">{t.name}</span>
          <span className="tool-menu-desc">{t.description}</span>
        </button>
      ))}
    </div>
  )
}

/** A tool's panel, for the machine it was opened on. */
export function ToolPanel({ panel }: { panel: Panel }) {
  const [id, where] = panel.targetId.split('@')
  const tool = TOOLS.find((t) => t.id === id)
  return tool ? <tool.Panel panel={panel} machineId={where === 'local' ? undefined : where} /> : null
}
