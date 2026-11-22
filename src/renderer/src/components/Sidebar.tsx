import { useEffect, useMemo, useRef, useState } from 'react'
import { WORKSPACE_NAME_MAX, type Workspace } from '@shared/types'
import { api, needsYou, sessionWorkspace, useStore } from '../store'
import { IconMeter, IconPencil, IconPlus, IconRemote, IconTools } from './icons'
import { MachineCard } from './Machines'
import { NeedsYouButton } from './NeedsYou'

/** A workspace's name, edited in place: Enter or leaving the field saves, Escape cancels. */
function RenameField({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [name, setName] = useState(workspace.name)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const clean = name.trim()
    if (save && clean && clean !== workspace.name) void api.workspaceRename(workspace.id, clean)
    onDone()
  }
  return (
    <input
      ref={input}
      className="side-rename"
      aria-label="Workspace name"
      value={name}
      maxLength={WORKSPACE_NAME_MAX}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
    />
  )
}

/**
 * The workspaces: each lists its own projects, notes and loops. A workspace shows how many sessions
 * it has, and in the signal color how many of them wait for you.
 */
function Workspaces() {
  const workspaces = useStore((s) => s.workspaces)
  const projects = useStore((s) => s.projects)
  const sessions = useStore((s) => s.sessions)
  const loops = useStore((s) => s.loops)
  const machines = useStore((s) => s.machines)
  const waitingSince = useStore((s) => s.waitingSince)
  const locked = useStore((s) => !!s.control)
  const [renaming, setRenaming] = useState<string | null>(null)

  const counts = useMemo(() => {
    const s = { workspaces, projects, loops }
    const total = new Map<string, number>()
    for (const x of Object.values(sessions)) {
      if (x.archived) continue
      const ws = sessionWorkspace(s, x)
      if (ws) total.set(ws, (total.get(ws) ?? 0) + 1)
    }
    const waiting = new Map<string, number>()
    for (const i of needsYou(useStore.getState())) if (!i.offline && i.workspace) waiting.set(i.workspace, (waiting.get(i.workspace) ?? 0) + 1)
    return { total, waiting }
  }, [workspaces, projects, sessions, loops, machines, waitingSince])

  return (
    <div className="side-section">
      <div className="side-head">
        <span>Workspaces</span>
        <button className="icon-btn" title="New workspace" disabled={locked} onClick={() => void api.workspaceCreate()}>
          <IconPlus size={14} />
        </button>
      </div>
      <div role="tablist" aria-orientation="vertical">
        {workspaces.list.map((w) => {
          const active = w.id === workspaces.active
          const waiting = counts.waiting.get(w.id) ?? 0
          if (renaming === w.id && !locked) return <RenameField key={w.id} workspace={w} onDone={() => setRenaming(null)} />
          return (
            <div key={w.id} className="side-row">
              <button
                role="tab"
                aria-selected={active}
                className={`side-item${active ? ' is-active' : ''}`}
                disabled={locked}
                title="Double-click to rename"
                onClick={() => !active && void api.workspaceSelect(w.id)}
                onDoubleClick={() => setRenaming(w.id)}
              >
                <span className="side-item-name">{w.name}</span>
                {waiting > 0 && (
                  <span className="ws-waiting" title={`${waiting} waiting for you`}>
                    {waiting}
                  </span>
                )}
                <span className="side-item-count">{counts.total.get(w.id) ?? 0}</span>
              </button>
              {!locked && (
                <button className="icon-btn" title={`Rename ${w.name}`} onClick={() => setRenaming(w.id)}>
                  <IconPencil />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** This PC first, then each remote machine. */
function Machines() {
  const machines = useStore((s) => s.machines)
  return (
    <div className="side-section">
      <div className="side-head">
        <span>Machines</span>
      </div>
      <MachineCard />
      {Object.values(machines).map((m) => (
        <MachineCard key={m.id} machine={m} />
      ))}
    </div>
  )
}

/** The tools (src/renderer/src/tools.ts). They belong to Symphony, not to a machine: each run picks one. */
function ToolsButton() {
  return (
    <button
      className="dock-btn"
      title="Tools"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        useStore.getState().setToolMenu({ left: rect.left, right: rect.right, top: rect.top })
      }}
    >
      <IconTools size={16} />
    </button>
  )
}

/** Usage at a glance: one bar per window (5-hour, weekly, weekly per model). Opens the usage panel. */
function UsageButton() {
  const usage = useStore((s) => s.usage)
  const windows = usage?.available ? usage.windows : []
  const title = windows.length ? windows.map((w) => `${w.label}: ${Math.round(w.percent)}%`).join('\n') : 'Claude usage'
  return (
    <button className="dock-btn" title={title} onClick={() => useStore.getState().openPanel('usage', 'claude')}>
      <IconMeter levels={windows.map((w) => w.percent / 100)} />
    </button>
  )
}

/** Remote machines: orchestrate others, or let one orchestrate this machine. */
function RemoteButton() {
  const linked = useStore((s) => Object.keys(s.machines).length > 0 || !!s.control)
  return (
    <button className={`dock-btn${linked ? ' is-on' : ''}`} title="Remote machines" onClick={() => useStore.getState().openPanel('remote', 'settings')}>
      <IconRemote />
    </button>
  )
}

export function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="side-scroll">
        <Workspaces />
        <Machines />
      </div>
      <div className="dock">
        <ToolsButton />
        <UsageButton />
        <RemoteButton />
        <NeedsYouButton />
      </div>
    </nav>
  )
}
