import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { lockReason, machineUp, useStore, type Panel } from '../store'
import { TOOLS } from '../tools'

/** The bubble the dock's tools button opens: every tool, for Symphony as a whole. */
export function ToolMenu() {
  const menu = useStore((s) => s.toolMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [side, setSide] = useState<'right' | 'left'>('right')

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    const fitsRight = menu.right + 14 + width <= window.innerWidth - 16
    setSide(fitsRight ? 'right' : 'left')
    // The button is in the dock at the bottom, so the bubble grows upward from it when it must.
    const top = Math.min(menu.top - 8, window.innerHeight - 16 - height)
    setPos({ left: fitsRight ? menu.right + 14 : Math.max(16, menu.left - 14 - width), top: Math.max(48, top) })
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
  return (
    <div ref={ref} className={`composer tool-menu from-${side}`} style={pos}>
      <span className="color-menu-label">Tools</span>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className="tool-menu-item"
          onClick={() => {
            const s = useStore.getState()
            s.setToolMenu(null)
            s.openPanel('tool', t.id)
          }}
        >
          <span className="tool-menu-name">{t.name}</span>
          <span className="tool-menu-desc">{t.description}</span>
        </button>
      ))}
    </div>
  )
}

/** A tool's panel. It is not tied to a machine; the tool picks one per run (MachineSelect). */
export function ToolPanel({ panel }: { panel: Panel }) {
  const tool = TOOLS.find((t) => t.id === panel.targetId)
  return tool ? <tool.Panel panel={panel} /> : null
}

/** A machine a tool can run on: this PC, or a paired remote machine. */
export interface MachineChoice {
  /** Undefined for this PC, as everywhere else machineId is. */
  machineId?: string
  name: string
  offline: boolean
  /** Why it cannot run anything right now (offline, or this window is controlled), or null. */
  lock: string | null
}

/** This PC, then every paired remote machine, offline ones included. */
export function useMachineChoices(): MachineChoice[] {
  // Subscribing to both is what re-renders on a change; lockReason reads the same state.
  const machines = useStore((s) => s.machines)
  useStore((s) => s.control)
  const s = useStore.getState()
  return [
    { name: 'This PC', offline: false, lock: lockReason(s) },
    ...Object.values(machines)
      .filter((m) => m.status !== 'pairing')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({ machineId: m.id, name: m.name, offline: !machineUp(m), lock: lockReason(s, m.id) }))
  ]
}

/** Which machine a tool runs on. Machines that cannot run anything right now are listed but disabled. */
export function MachineSelect({ value, onChange }: { value?: string; onChange: (machineId?: string) => void }) {
  const choices = useMachineChoices()
  return (
    <select className="model" value={value ?? 'local'} onChange={(e) => onChange(e.target.value === 'local' ? undefined : e.target.value)} title="The machine it runs on">
      {choices.map((c) => (
        <option key={c.machineId ?? 'local'} value={c.machineId ?? 'local'} disabled={!!c.lock}>
          On {c.name}
          {c.offline ? ' (offline)' : ''}
        </option>
      ))}
    </select>
  )
}
