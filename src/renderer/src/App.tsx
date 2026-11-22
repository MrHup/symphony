import { useEffect, useState } from 'react'
import './monaco'
import { ColorMenu } from './components/ColorMenu'
import { ComposerBubble } from './components/Composer'
import { ControlBanner } from './components/ControlBanner'
import { Lightbox } from './components/Files'
import { FloatingPanel, PanelTray } from './components/FloatingPanel'
import { FolderBrowserPanel, PairingPanel } from './components/MachinePanels'
import { NeedsYouPanel, useNeedsYouShortcut } from './components/NeedsYou'
import { RemotePanel } from './components/RemotePanel'
import { TerminalPanel } from './components/TerminalPanel'
import { ToolMenu, ToolPanel } from './components/ToolMenu'
import { UsagePanel } from './components/UsagePanel'
import { LoopPanel } from './components/LoopPanel'
import { SessionList } from './components/SessionList'
import { AgentPanel, SessionPanel } from './components/SessionView'
import { Sidebar } from './components/Sidebar'
import { ClaudeMdPanel, DiffPanel } from './components/Viewer'
import { api, claimForWorkspace, useStore, type Panel } from './store'

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
    case 'tool':
      return <ToolPanel panel={panel} />
  }
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

export function App() {
  const ready = useStore((s) => s.ready)
  const panels = useStore((s) => s.panels)
  const [dragging, setDragging] = useState(false)
  useNeedsYouShortcut()

  useEffect(() => {
    const off = api.onEvent((e) => useStore.getState().apply(e))
    void api.snapshot().then((s) => useStore.getState().load(s))
    document.documentElement.classList.add(`platform-${api.platform}`)
    return off
  }, [])

  // Dropping a folder anywhere adds it as a project. Drops a project, prompt or reply box took
  // (files for .claude-references) arrive here already handled.
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
      setDragging(false)
      if (e.defaultPrevented) return
      e.preventDefault()
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        const path = api.pathForFile(file)
        if (path) void api.addProject(path).then(claimForWorkspace)
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
    <>
      <div className="drag-strip" />
      <AppMark />
      {ready && (
        <div className="shell">
          <Sidebar />
          <SessionList />
        </div>
      )}
      <ControlBanner />
      <div className="tray-dock">
        <PanelTray />
      </div>
      {panels.map((p) => (
        <PanelFor key={p.id} panel={p} />
      ))}
      <ComposerBubble />
      <ColorMenu />
      <ToolMenu />
      <Lightbox />
      {dragging && <div className="drop-target" />}
    </>
  )
}
