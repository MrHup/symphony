import { useEffect, useState } from 'react'
import { api, useStore, type Panel } from '../store'
import { FloatingPanel } from './FloatingPanel'
import { IconRefresh } from './icons'

function resetText(iso: string | null, now: number): string {
  if (!iso) return 'not started'
  const at = new Date(iso).getTime()
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  if (mins < 60) return `resets in ${mins} min`
  if (mins < 24 * 60) return `resets in ${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`
  return `resets ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

function ago(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60_000)
  return mins < 1 ? 'just now' : `${mins} min ago`
}

/** Plan usage as progress bars: the 5-hour session window, the weekly window, and weekly per-model windows (Fable). */
export function UsagePanel({ panel }: { panel: Panel }) {
  const usage = useStore((s) => s.usage)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const refresh = async () => {
    setBusy(true)
    await api.refreshUsage()
    setBusy(false)
    setNow(Date.now())
  }
  useEffect(() => {
    // Fresh numbers whenever the panel opens.
    void refresh()
  }, [])

  const plan = usage?.plan ? `${usage.plan.charAt(0).toUpperCase()}${usage.plan.slice(1)} plan` : undefined
  return (
    <FloatingPanel
      panel={panel}
      title="Claude usage"
      meta={[plan, usage && ago(usage.fetchedAt, now)].filter(Boolean).join(' · ')}
      actions={
        <button className="icon-btn" title="Refresh" disabled={busy} onClick={() => void refresh()}>
          <IconRefresh />
        </button>
      }
    >
      <div className="usage">
        {!usage ? (
          <p className="usage-note">Reading usage…</p>
        ) : !usage.available ? (
          <p className="usage-note">{usage.error ?? 'Plan limits do not apply to this login (API key or cloud provider).'}</p>
        ) : (
          usage.windows.map((w) => (
            <div key={w.id} className="usage-row">
              <div className="usage-head">
                <span>{w.label}</span>
                <span className="usage-pct">{Math.round(w.percent)}%</span>
              </div>
              <div className="usage-track" role="progressbar" aria-valuenow={Math.round(w.percent)} aria-valuemin={0} aria-valuemax={100} aria-label={w.label}>
                <div className="usage-fill" style={{ width: `${Math.min(100, Math.max(0, w.percent))}%` }} />
              </div>
              <div className="usage-reset">{resetText(w.resetsAt, now)}</div>
            </div>
          ))
        )}
      </div>
    </FloatingPanel>
  )
}
