import { useEffect, useState } from 'react'
import type { AuditEntry, RemoteStatus } from '@shared/types'
import { api, clock, useStore, type Panel } from '../store'
import { cleanError } from './Composer'
import { FloatingPanel } from './FloatingPanel'
import { IconClose } from './icons'

const LINK_STATE: Record<RemoteStatus['remote']['state'], string> = {
  off: 'off',
  unpaired: 'not paired yet',
  pairing: 'pairing',
  connecting: 'connecting',
  connected: 'connected',
  grace: 'connection lost, reconnecting',
  retrying: 'waiting for the orchestrator'
}

const ago = (t: number) => {
  const mins = Math.round((Date.now() - t) / 60_000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${new Date(t).toLocaleDateString()} ${clock(t)}`
}

/** Remote orchestration for both roles: orchestrate other machines, or let one orchestrate this machine. */
export function RemotePanel({ panel }: { panel: Panel }) {
  const status = useStore((s) => s.remote)
  const control = useStore((s) => s.control)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.remoteStatus().then((r) => useStore.setState({ remote: r }))
  }, [])

  const run = (call: () => Promise<unknown>) => {
    setError(null)
    call().catch((err) => setError(cleanError(err)))
  }

  if (!status) return null
  const o = status.orchestrator
  const r = status.remote
  const locked = !!control

  return (
    <FloatingPanel panel={panel} title="Remote machines" meta={status.machineName}>
      <div className="remote">
        {error && <p className="loop-error">{error}</p>}

        <section className="remote-section">
          <label className="remote-toggle">
            <input type="checkbox" checked={o.enabled} disabled={locked} onChange={(e) => run(() => api.remoteSetOrchestrate(e.target.checked))} />
            <span>
              <strong>Orchestrate other machines</strong>
              <span className="remote-hint">Listen on this network for Symphony machines in remote mode. They connect here; nothing is installed on them.</span>
            </span>
          </label>
          {o.enabled && (
            <div className="remote-detail">
              <div className="remote-row">
                <span className="remote-label">Listening</span>
                <span className="mono">{o.addresses.length ? `${o.addresses.join(', ')} · port ${o.port}` : 'starting…'}</span>
              </div>
              {o.error && <p className="loop-error">{o.error}</p>}
            </div>
          )}
          {o.pairing.map((p) => (
            <div key={p.id} className="t-request">
              <div className="t-request-head">
                <span>{p.name} wants to pair</span>
              </div>
              <div className="pair-code">{p.code}</div>
              <p className="remote-hint">Accept only if {p.name} shows the same code.</p>
              <div className="t-request-actions">
                <button className="btn signal" disabled={p.accepted} onClick={() => run(() => api.remotePairDecision(p.id, true))}>
                  {p.accepted ? `Waiting for ${p.name}…` : 'Codes match, accept'}
                </button>
                <button className="btn" onClick={() => run(() => api.remotePairDecision(p.id, false))}>
                  Reject
                </button>
              </div>
            </div>
          ))}
          {o.machines.length > 0 && (
            <div className="remote-list">
              <div className="detail-label">Paired machines</div>
              {o.machines.map((m) => (
                <div key={m.id} className="remote-row">
                  <span>{m.name}</span>
                  <span className="remote-meta">{m.status === 'online' ? 'connected' : `${m.status} · last seen ${ago(m.lastSeen)}`}</span>
                  <button className="btn ghost small" disabled={locked} onClick={() => run(() => api.remoteRevoke(m.id))}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="remote-section">
          <label className="remote-toggle">
            <input type="checkbox" checked={r.enabled} disabled={locked} onChange={(e) => run(() => api.remoteSetRemoteMode(e.target.checked))} />
            <span>
              <strong>Let a Symphony on this network orchestrate this machine</strong>
              <span className="remote-hint">It gets the same power Symphony has here: sessions in the shared folders, CLAUDE.md, and terminals if allowed. While it is connected, this window is read-only.</span>
            </span>
          </label>
          {r.enabled && (
            <div className="remote-detail">
              <div className="remote-row">
                <span className="remote-label">Status</span>
                <span>{LINK_STATE[r.state]}</span>
              </div>
              {r.error && r.state !== 'connected' && <p className="loop-error">{r.error}</p>}
              {r.pairing ? (
                <div className="t-request">
                  <div className="t-request-head">
                    <span>Pairing with {r.pairing.name}</span>
                  </div>
                  <div className="pair-code">{r.pairing.code}</div>
                  <p className="remote-hint">Accept only if {r.pairing.name} shows the same code.{r.pairing.peerAccepted ? ` ${r.pairing.name} accepted.` : ''}</p>
                  <div className="t-request-actions">
                    <button className="btn signal" disabled={r.pairing.accepted} onClick={() => run(() => api.remotePairDecision('orchestrator', true))}>
                      {r.pairing.accepted ? `Waiting for ${r.pairing.name}…` : 'Codes match, accept'}
                    </button>
                    <button className="btn" onClick={() => run(() => api.remotePairDecision('orchestrator', false))}>
                      Reject
                    </button>
                  </div>
                </div>
              ) : r.pc ? (
                <div className="remote-row">
                  <span className="remote-label">Orchestrator</span>
                  <span>
                    {r.pc.name} <span className="mono remote-meta">{`${r.pc.host}:${r.pc.port}`}</span>
                  </span>
                  <button className="btn ghost small" disabled={locked} onClick={() => run(() => api.remoteRevoke('orchestrator'))}>
                    Revoke
                  </button>
                </div>
              ) : (
                <PairPicker status={r} run={run} />
              )}
              {(r.state === 'connected' || r.state === 'grace') && (
                <button className="btn" onClick={() => run(() => api.remoteDisconnect())}>
                  Disconnect
                </button>
              )}
              <SharedFolders folders={r.sharedFolders} locked={locked} run={run} />
              <label className="remote-toggle">
                <input type="checkbox" checked={r.terminals} disabled={locked} onChange={(e) => run(() => api.remoteSettings({ terminals: e.target.checked }))} />
                <span>
                  <strong>Allow terminals</strong>
                  <span className="remote-hint">The orchestrator can open a shell on this machine.</span>
                </span>
              </label>
              <label className="remote-row">
                <span className="remote-label">Read-only after a drop</span>
                <input
                  className="remote-number"
                  type="number"
                  min={0}
                  max={60}
                  disabled={locked}
                  defaultValue={Math.round(r.graceSeconds / 60)}
                  onBlur={(e) => run(() => api.remoteSettings({ graceSeconds: Math.max(0, Number(e.target.value) || 0) * 60 }))}
                />
                <span className="remote-meta">minutes (0: editable at once)</span>
              </label>
              <Audit />
            </div>
          )}
        </section>

        <section className="remote-section">
          <div className="remote-row">
            <span className="remote-hint">No claude command on this machine? Sign in with the Claude Code binary that ships with Symphony.</span>
            <button className="btn" disabled={locked} onClick={() => useStore.getState().openPanel('terminal', `claude-login#${Date.now()}`)}>
              Sign in to Claude
            </button>
          </div>
        </section>
      </div>
    </FloatingPanel>
  )
}

/** Orchestrators found over mDNS, or an address typed in. */
function PairPicker({ status, run }: { status: RemoteStatus['remote']; run: (call: () => Promise<unknown>) => void }) {
  const [address, setAddress] = useState('')
  return (
    <div className="remote-list">
      <div className="detail-label">Pair with an orchestrator</div>
      {status.discovered.length === 0 && <p className="remote-hint">Looking on this network…</p>}
      {status.discovered.map((d) => (
        <div key={d.id} className="remote-row">
          <span>{d.name}</span>
          <span className="mono remote-meta">{`${d.host}:${d.port}`}</span>
          <button className="btn small" onClick={() => run(() => api.remotePair(`${d.host}:${d.port}`))}>
            Pair
          </button>
        </div>
      ))}
      <div className="remote-row">
        <input className="remote-input" placeholder="Or enter its address, e.g. 192.168.1.20" value={address} onChange={(e) => setAddress(e.target.value)} />
        <button className="btn small" disabled={!address.trim()} onClick={() => run(() => api.remotePair(address.trim()))}>
          Pair
        </button>
      </div>
    </div>
  )
}

function SharedFolders({ folders, locked, run }: { folders: string[]; locked: boolean; run: (call: () => Promise<unknown>) => void }) {
  return (
    <div className="remote-list">
      <div className="detail-label">Shared folders (projects can only be added from these)</div>
      {folders.map((f) => (
        <div key={f} className="remote-row">
          <span className="mono">{f}</span>
          <button className="icon-btn" title="Stop sharing" disabled={locked || folders.length <= 1} onClick={() => run(() => api.remoteSettings({ sharedFolders: folders.filter((x) => x !== f) }))}>
            <IconClose />
          </button>
        </div>
      ))}
      <button
        className="btn ghost small"
        disabled={locked}
        onClick={() =>
          run(async () => {
            const picked = await api.remotePickFolder()
            if (picked) await api.remoteSettings({ sharedFolders: [...folders, picked] })
          })
        }
      >
        + Share a folder
      </button>
    </div>
  )
}

/** What the orchestrator did on this machine. */
function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  if (!entries) {
    return (
      <button className="btn ghost small" onClick={() => void api.remoteAudit().then(setEntries)}>
        Show the audit log
      </button>
    )
  }
  return (
    <div className="remote-list">
      <div className="detail-label">Audit log</div>
      {entries.length === 0 && <p className="remote-hint">Nothing yet.</p>}
      <div className="audit">
        {entries.map((e, i) => (
          <div key={i} className="remote-row">
            <span className="remote-meta mono">{`${new Date(e.at).toLocaleDateString()} ${clock(e.at)}`}</span>
            <span>{e.action}</span>
            {e.detail && <span className="remote-meta">{e.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
