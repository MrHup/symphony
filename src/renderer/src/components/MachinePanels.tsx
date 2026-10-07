import { useEffect, useState } from 'react'
import type { FolderListing } from '@shared/types'
import { api, useLock, useStore, type Panel } from '../store'
import { cleanError } from './Composer'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'
import { IconFolder } from './icons'

/** A machine asks to pair: compare the code it shows with this one, then accept or reject. */
export function PairingPanel({ panel }: { panel: Panel }) {
  const machine = useStore((s) => s.machines[panel.targetId])
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  if (!machine) return null
  const decide = (accept: boolean) => {
    setError(null)
    if (accept) setAccepted(true)
    api
      .remotePairDecision(machine.id, accept)
      .then(() => !accept && useStore.getState().closePanel(panel.id))
      .catch((err) => setError(cleanError(err)))
  }
  const paired = machine.status !== 'pairing'
  return (
    <FloatingPanel
      panel={panel}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <Glyph status={paired ? 'idle' : 'input'} size={10} />
          Pair with {machine.name}
        </span>
      }
    >
      <div className="remote">
        {paired ? (
          <p>{machine.name} is paired.</p>
        ) : (
          <>
            <p className="remote-hint">{machine.name} shows a 6-digit code. Accept only if it is the same as this one.</p>
            <div className="pair-code">{machine.pairCode}</div>
            <div className="t-request-actions">
              <button className="btn signal" disabled={accepted} onClick={() => decide(true)}>
                {accepted ? `Waiting for ${machine.name}…` : 'Codes match, accept'}
              </button>
              <button className="btn" onClick={() => decide(false)}>
                Reject
              </button>
            </div>
          </>
        )}
        {error && <p className="loop-error">{error}</p>}
      </div>
    </FloatingPanel>
  )
}

/** Pick a project folder on a remote machine, limited to the folders it shares. */
export function FolderBrowserPanel({ panel }: { panel: Panel }) {
  const machine = useStore((s) => s.machines[panel.targetId])
  const lock = useLock(panel.targetId)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const open = (path?: string) => {
    setError(null)
    api
      .remoteBrowse(panel.targetId, path)
      .then(setListing)
      .catch((err) => setError(cleanError(err)))
  }
  useEffect(() => open(), [panel.targetId])

  if (!machine) return null
  const add = (path: string) => {
    setBusy(true)
    setError(null)
    api
      .addProject(path, machine.id)
      .then((p) => (p ? useStore.getState().closePanel(panel.id) : setError('That folder could not be added.')))
      .catch((err) => setError(cleanError(err)))
      .finally(() => setBusy(false))
  }
  return (
    <FloatingPanel panel={panel} machineId={machine.id} title="Add a project" meta={listing?.path ? listing.path.split(/[\\/]/).filter(Boolean).pop() : 'shared folders'}>
      <div className="folders">
        <div className="folders-bar">
          {listing?.path && (
            <button className="btn ghost small" onClick={() => open(listing.parent ?? undefined)}>
              ↑ {listing.parent ? 'Up' : 'Shared folders'}
            </button>
          )}
          <span className="spacer" />
          {listing?.path && (
            <button className="btn primary small" disabled={busy || !!lock} onClick={() => add(listing.path!)}>
              Add this folder
            </button>
          )}
        </div>
        {listing?.path && <div className="folders-path mono">{listing.path}</div>}
        {error && <p className="loop-error">{error}</p>}
        <div className="folders-list">
          {listing?.entries.map((e) => (
            <div key={e.path} className="folder-row">
              <button className="folder-open" onClick={() => open(e.path)} title={e.path}>
                <IconFolder />
                <span className="name">{e.name}</span>
                {e.git && <span className="remote-meta">git</span>}
              </button>
              <button className="btn ghost small" disabled={busy || !!lock} onClick={() => add(e.path)}>
                Add
              </button>
            </div>
          ))}
          {listing && !listing.entries.length && <p className="remote-hint">No folders here.</p>}
        </div>
      </div>
    </FloatingPanel>
  )
}
