import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import './monaco'
import { ComposerBubble } from './components/Composer'
import { FloatingPanel } from './components/FloatingPanel'
import { Graph } from './components/Graph'
import { IconMeter, IconPlus, IconTerminal } from './components/icons'
import { TerminalPanel } from './components/TerminalPanel'
import { UsagePanel } from './components/UsagePanel'
import { AgentPanel, SessionPanel } from './components/SessionView'
import { ClaudeMdPanel, DiffPanel, McpPanel, SkillPanel } from './components/Viewer'
import { api, useStore, type Panel } from './store'

function LoginPanel({ panel }: { panel: Panel }) {
  const login = useStore((s) => s.login)
  const gh = useStore((s) => s.gh)
  const account = gh.hosts['github.com']?.find((a) => a.active)
  return (
    <FloatingPanel panel={panel} title="GitHub">
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

export function App() {
  const ready = useStore((s) => s.ready)
  const panels = useStore((s) => s.panels)
  const hasProjects = useStore((s) => Object.keys(s.projects).length > 0)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const off = api.onEvent((e) => useStore.getState().apply(e))
    void api.snapshot().then((s) => useStore.getState().load(s))
    document.documentElement.classList.add(`platform-${api.platform}`)
    return off
  }, [])

  // Dropping a folder anywhere adds it as a project.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
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
      <div className="app-mark">Symphony</div>
      {ready && <Graph />}
      {ready && !hasProjects && (
        <div className="empty-hint">
          <strong>Add a project folder</strong>, or drop one anywhere. Right-click a project to start a session.
        </div>
      )}
      <div className="dock">
        <button className="dock-btn" title="Add a project folder" onClick={() => void api.addProject()}>
          <IconPlus />
        </button>
        <button className="dock-btn" title="Terminal in your home folder" onClick={() => useStore.getState().openTerminal(null)}>
          <IconTerminal size={16} />
        </button>
        <UsageButton />
      </div>
      {panels.map((p) => (
        <PanelFor key={p.id} panel={p} />
      ))}
      <ComposerBubble />
      {dragging && <div className="drop-target" />}
    </ReactFlowProvider>
  )
}
