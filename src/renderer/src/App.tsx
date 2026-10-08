import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import './monaco'
import { ComposerBubble } from './components/Composer'
import { ControlBanner } from './components/ControlBanner'
import { Lightbox } from './components/Files'
import { FloatingPanel } from './components/FloatingPanel'
import { Graph } from './components/Graph'
import { IconAutoApprove, IconMeter, IconPlus, IconRemote, IconTerminal } from './components/icons'
import { FolderBrowserPanel, PairingPanel } from './components/MachinePanels'
import { NeedsYouButton, NeedsYouPanel, useNeedsYouShortcut } from './components/NeedsYou'
import { RemotePanel } from './components/RemotePanel'
import { TerminalPanel } from './components/TerminalPanel'
import { UsagePanel } from './components/UsagePanel'
import { LoopPanel } from './components/LoopPanel'
import { AgentPanel, SessionPanel } from './components/SessionView'
import { ClaudeMdPanel, DiffPanel, McpPanel, SkillPanel } from './components/Viewer'
import { api, useStore, type Panel } from './store'

/** GitHub sign-in for one machine (targetId: 'local' or a machine id). */
function LoginPanel({ panel }: { panel: Panel }) {
  const machineId = panel.targetId === 'local' ? undefined : panel.targetId
  const login = useStore((s) => s.logins[panel.targetId])
  const gh = useStore((s) => (machineId ? s.machines[machineId]?.gh : s.gh))
  const account = gh?.hosts['github.com']?.find((a) => a.active)
  return (
    <FloatingPanel panel={panel} title="GitHub" machineId={machineId}>
      <div className="login">
        {login?.done && !login.error && account ? (
          <p>
            Signed in as <span className="identity">@{account.login}</span>. New sessions use this account.
          </p>
        ) : login?.error ? (
          <p>{login.error}</p>
        ) : login?.code ? (
          <>
            <p>Enter this code on the GitHub page that just opened.</p>
            <div className="code">{login.code}</div>
            {login.url && (
              <p>
                <a href={login.url} style={{ color: 'var(--bone)' }} onClick={(e) => (e.preventDefault(), window.open(login.url!))}>
                  {login.url}
                </a>
              </p>
            )}
          </>
        ) : (
          <p>Asking GitHub for a sign-in code…</p>
        )}
      </div>
    </FloatingPanel>
  )
}

function PanelFor({ panel }: { panel: Panel }) {
  switch (panel.kind) {
    case 'session':
      return <SessionPanel panel={panel} />
    case 'agent':
      return <AgentPanel panel={panel} />
    case 'diff':
      return <DiffPanel panel={panel} />
    case 'skill':
      return <SkillPanel panel={panel} />
    case 'mcp':
      return <McpPanel panel={panel} />
    case 'claudemd':
      return <ClaudeMdPanel panel={panel} />
    case 'login':
      return <LoginPanel panel={panel} />
    case 'terminal':
      return <TerminalPanel panel={panel} />
    case 'usage':
      return <UsagePanel panel={panel} />
    case 'loop':
      return <LoopPanel panel={panel} />
    case 'remote':
      return <RemotePanel panel={panel} />
    case 'folders':
      return <FolderBrowserPanel panel={panel} />
    case 'pairing':
      return <PairingPanel panel={panel} />
    case 'needs':
      return <NeedsYouPanel panel={panel} />
  }
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

/** The window title, with a reminder while auto-approve is on. */
function AppMark() {
  const on = useStore((s) => s.autoApprove)
  return (
    <div className="app-mark">
      Symphony{on && <span className="app-mark-state"> · auto-approving</span>}
    </div>
  )
}

/** This machine's auto-approve; each remote machine has its own toggle on its node. */
function AutoApproveButton() {
  const on = useStore((s) => s.autoApprove)
  const control = useStore((s) => s.control)
  return (
    <button
      className={`dock-btn${on ? ' is-on' : ''}`}
      aria-pressed={on}
      disabled={!!control}
      title={on ? 'Auto-approve is on: permission prompts are allowed without asking. Click to turn off.' : 'Auto-approve: allow permission prompts without asking'}
      onClick={() => void api.setAutoApprove(!on)}
    >
      <IconAutoApprove />
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

export function App() {
  const ready = useStore((s) => s.ready)
  const panels = useStore((s) => s.panels)
  const hasProjects = useStore((s) => Object.keys(s.projects).length > 0)
  const control = useStore((s) => s.control)
  const [dragging, setDragging] = useState(false)
  useNeedsYouShortcut()

  useEffect(() => {
    const off = api.onEvent((e) => useStore.getState().apply(e))
    void api.snapshot().then((s) => useStore.getState().load(s))
    document.documentElement.classList.add(`platform-${api.platform}`)
    return off
  }, [])

  // Dropping a folder anywhere adds it as a project.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') || useStore.getState().control) return
      e.preventDefault()
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        const path = api.pathForFile(file)
        if (path) void api.addProject(path)
      }
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <ReactFlowProvider>
      <div className="drag-strip" />
      <AppMark />
      {ready && <Graph />}
      {ready && !hasProjects && (
        <div className="empty-hint">
          <strong>Add a project folder</strong>, or drop one anywhere. Right-click a project to start a session.
        </div>
      )}
      <ControlBanner />
      <div className="dock">
        <button className="dock-btn" title="Add a project folder" disabled={!!control} onClick={() => void api.addProject()}>
          <IconPlus />
        </button>
        <button className="dock-btn" title="Terminal in your home folder" disabled={!!control} onClick={() => useStore.getState().openTerminal(null)}>
          <IconTerminal size={16} />
        </button>
        <UsageButton />
        <AutoApproveButton />
        <RemoteButton />
        <NeedsYouButton />
      </div>
      {panels.map((p) => (
        <PanelFor key={p.id} panel={p} />
      ))}
      <ComposerBubble />
      <Lightbox />
      {dragging && <div className="drop-target" />}
    </ReactFlowProvider>
  )
}
