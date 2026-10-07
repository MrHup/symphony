import { useEffect, useRef, useState } from 'react'
import type { NodeStatus } from '@shared/types'

export type GlyphVariant = 'default' | 'hub' | 'failed' | 'optimize'

/**
 * The shape that carries a node's status:
 *   idle      filled grey circle
 *   working   circle with a thin rotating arc
 *   input     filled square in the signal color
 *   approval  filled diamond in the signal color
 *   finished  outline circle (the node itself fades to 40%)
 * It shakes once, with a damped movement, each time it starts needing the user.
 */
export function Glyph({ status, size, variant = 'default' }: { status: NodeStatus; size: number; variant?: GlyphVariant }) {
  const [shakeKey, setShakeKey] = useState(0)
  const prev = useRef(status)
  useEffect(() => {
    const wasWaiting = prev.current === 'input' || prev.current === 'approval'
    const isWaiting = status === 'input' || status === 'approval'
    if (isWaiting && (!wasWaiting || prev.current !== status)) setShakeKey((k) => k + 1)
    prev.current = status
  }, [status])

  const r = size / 2
  const pad = Math.max(5, size * 0.28)
  const box = size + pad * 2
  const c = box / 2
  const stroke = size >= 20 ? 1.5 : 1.25

  let shape: React.ReactNode
  if (status === 'input') {
    const s = size * 0.86
    shape = <rect className="shape" x={c - s / 2} y={c - s / 2} width={s} height={s} rx={1.5} fill="var(--signal)" />
  } else if (status === 'approval') {
    const d = r * 1.18
    shape = <path className="shape" d={`M ${c} ${c - d} L ${c + d} ${c} L ${c} ${c + d} L ${c - d} ${c} Z`} fill="var(--signal)" strokeLinejoin="round" />
  } else if (status === 'finished') {
    shape = <circle className="shape" cx={c} cy={c} r={r - stroke / 2} fill="none" stroke="var(--bone)" strokeWidth={stroke} />
  } else if (variant === 'failed') {
    const o = (r - stroke) * 0.7
    shape = (
      <>
        <circle className="shape" cx={c} cy={c} r={r - stroke / 2} fill="none" stroke="var(--grey-2)" strokeWidth={stroke} />
        <line x1={c - o} y1={c + o} x2={c + o} y2={c - o} stroke="var(--grey-2)" strokeWidth={stroke} />
      </>
    )
  } else if (variant === 'hub') {
    shape = (
      <>
        <circle className="shape" cx={c} cy={c} r={r - stroke / 2} fill="none" stroke="var(--grey-3)" strokeWidth={stroke} />
        <circle className="shape" cx={c} cy={c} r={r * 0.42} fill="var(--bone)" />
      </>
    )
  } else if (variant === 'optimize') {
    shape = <circle className="shape" cx={c} cy={c} r={r - stroke / 2} fill="none" stroke="var(--grey-3)" strokeWidth={stroke} strokeDasharray={`${size / 6} ${size / 9}`} />
  } else {
    const fill = status === 'working' ? 'var(--grey-3)' : 'var(--grey-2)'
    shape = <circle className="shape" cx={c} cy={c} r={r - 0.5} fill={fill} />
  }

  const arcR = r + pad * 0.62
  const arc =
    status === 'working' ? (
      <circle
        className="arc"
        cx={c}
        cy={c}
        r={arcR}
        fill="none"
        stroke="var(--bone)"
        strokeWidth={1}
        strokeLinecap="round"
        strokeDasharray={`${arcR * 1.6} ${arcR * 10}`}
      />
    ) : null

  return (
    <span key={shakeKey} className={`glyph${shakeKey ? ' shake' : ''}`} style={{ width: box, height: box, margin: -pad }}>
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden>
        {arc}
        {shape}
      </svg>
    </span>
  )
}

export function statusLabel(status: NodeStatus): string {
  switch (status) {
    case 'working':
      return 'Working'
    case 'input':
      return 'Needs your input'
    case 'approval':
      return 'Needs your approval'
    case 'finished':
      return 'Finished'
    default:
      return 'Idle'
  }
}
