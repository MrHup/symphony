import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MACHINE_COLORS, type MachineColor } from '@shared/types'
import { useStore } from '../store'

/** The bubble that opens on right-clicking a machine node: the glyph color of everything on that machine. */
export function ColorMenu() {
  const menu = useStore((s) => s.colorMenu)
  const name = useStore((s) => (!menu ? '' : menu.machineId === 'local' ? 'This PC' : (s.machines[menu.machineId]?.name ?? '')))
  const current = useStore((s) => (menu ? s.machineColors[menu.machineId] : undefined))
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
    const close = () => useStore.getState().setColorMenu(null)
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
  const pick = (color: MachineColor | null) => {
    const s = useStore.getState()
    s.setMachineColor(menu.machineId, color)
    s.setColorMenu(null)
  }

  return (
    <div ref={ref} className={`composer color-menu from-${side}`} style={pos}>
      <span className="color-menu-label">{name}</span>
      <div className="swatches">
        {MACHINE_COLORS.map((c) => (
          <button key={c} className={`swatch accent-${c}${current === c ? ' is-on' : ''}`} title={`Color: ${c}`} aria-pressed={current === c} onClick={() => pick(c)} />
        ))}
        <button className={`swatch is-none${current ? '' : ' is-on'}`} title="No color" aria-pressed={!current} onClick={() => pick(null)} />
      </div>
    </div>
  )
}
