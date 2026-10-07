// Hairline icons drawn to match the glyphs. currentColor everywhere so they stay monochrome.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const IconPlus = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)

export const IconClose = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
  </svg>
)

/** A page with a folded corner: the project's CLAUDE.md. */
export const IconDoc = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M3.5 1.75h4.5l2.5 2.5v8H3.5z" />
    <path d="M8 1.75v2.5h2.5M5.25 7.25h3.5M5.25 9.5h3.5" />
  </svg>
)

export const IconStop = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" fill="currentColor" />
  </svg>
)

export const IconSend = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M7 11.5v-9M3.25 6.25L7 2.5l3.75 3.75" />
  </svg>
)

export const IconRefresh = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M11.5 6.5A4.5 4.5 0 1 0 10.2 10" />
    <path d="M11.75 2.75v3.75H8" />
  </svg>
)

export const IconTrash = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M2.75 4h8.5M5.5 4V2.75h3V4M4 4l.5 7.25h5L10 4" />
  </svg>
)

/** A prompt chevron and cursor: open a terminal. */
export const IconTerminal = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M2.75 4.25L5.5 7l-2.75 2.75M7 10.25h4.25" />
  </svg>
)

/** Three bars filled to the given fractions (0–1): the usage meter. */
export const IconMeter = ({ levels, size = 16 }: { levels: number[]; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    {[0, 1, 2].map((i) => {
      const x = 3 + i * 4
      const h = 10 * Math.min(1, Math.max(0, levels[i] ?? 0))
      return (
        <g key={i}>
          <rect x={x} y={3} width={2} height={10} rx={0.5} fill="currentColor" opacity={0.25} />
          {h > 0 && <rect x={x} y={13 - Math.max(h, 0.8)} width={2} height={Math.max(h, 0.8)} rx={0.5} fill="currentColor" />}
        </g>
      )
    })}
  </svg>
)

/** A cycle arrow: create a loop. */
export const IconLoop = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M10.9 4.75A4.5 4.5 0 1 0 11.5 7" />
    <path d="M11.25 1.75v3h-3" />
  </svg>
)

/** Two screens joined by a line: remote orchestration. */
export const IconRemote = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
    <rect x="1.75" y="2.75" width="5.5" height="4" rx="0.75" />
    <rect x="8.75" y="9.25" width="5.5" height="4" rx="0.75" />
    <path d="M4.5 6.75v4.5h4.25" />
  </svg>
)

/** A folder: browse a machine's shared folders. */
export const IconFolder = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <path d="M1.75 3.75h3.5l1.25 1.25h5.75v5.75H1.75z" />
  </svg>
)

/** A battery filled to `level` (0–1). */
export const IconBattery = ({ level, size = 14 }: { level: number; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" {...base}>
    <rect x="1.25" y="4.25" width="10" height="5.5" rx="1" />
    <path d="M12.75 6v2" />
    <rect x="2.5" y="5.5" width={Math.max(0.5, 7.5 * Math.min(1, Math.max(0, level)))} height="3" rx="0.4" fill="currentColor" stroke="none" />
  </svg>
)

/** Two check marks: approve automatically. */
export const IconAutoApprove = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
    <path d="M1.75 8.25l2.75 2.75 5-6" />
    <path d="M7.25 10.25l.75.75 6-7" />
  </svg>
)
