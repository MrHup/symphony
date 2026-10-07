import { useEffect, useState } from 'react'
import { api, useStore } from '../store'

/** On a remote machine: who controls it, and Disconnect, the one action that stays available here. */
export function ControlBanner() {
  const control = useStore((s) => s.control)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (control?.mode !== 'grace') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [control?.mode])
  if (!control) return null
  const left = Math.max(0, Math.ceil(((control.graceEndsAt ?? now) - now) / 1000))
  return (
    <div className="control-banner" role="status">
      <span>
        {control.mode === 'grace'
          ? `Connection to ${control.by} lost, reconnecting… read-only for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
          : `Orchestrated by ${control.by}, read-only`}
      </span>
      <button className="btn small" onClick={() => void api.remoteDisconnect()}>
        Disconnect
      </button>
    </div>
  )
}
