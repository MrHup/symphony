import { useEffect, useMemo, useRef, useState } from 'react'
import { EFFORT_LABELS, type AgentInfo, type LoopInfo, type NodeStatus, type Project, type SessionInfo } from '@shared/types'
import { api, clock, inWorkspace, lockReason, loopStatus, machineUp, rollup, sessionWorkspace, useLock, useModelLabel, useStore } from '../store'
import { uploadReferences, useFileDrop } from '../references'
import { cleanError } from './Composer'
import { Glyph, statusLabel } from './Glyph'
import { IconChevron, IconDoc, IconNote, IconOpenFolder, IconPlus, IconTerminal, IconTrash } from './icons'
import { MachineTag, useTint } from './Machines'
import { createNote, NotesSection } from './Notes'

const nf = new Intl.NumberFormat('en-US')

/** Finished sessions shown in a project before "Show earlier"; sessions still going are always shown. */
const FINISHED_SHOWN = 6

/** How long the note after dropping files stays on a project. */
const DROP_NOTE_MS = 4000

/** The open-folder button's label, in the words of this machine's OS. */
const FILE_MANAGER = api.platform === 'win32' ? 'Open in File Explorer' : api.platform === 'darwin' ? 'Open in Finder' : 'Open in the file manager'

const DAY_MS = 24 * 60 * 60 * 1000

/** When a session started: the time today, the weekday this week, the date before that. */
function when(t: number): string {
  const d = new Date(t)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return clock(t)
  if (Date.now() - t < 6 * DAY_MS) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** Everything on an offline machine loses the signal color: it cannot be answered until the machine is back. */
const shown = (status: NodeStatus, offline: boolean): NodeStatus => (offline ? (status === 'finished' ? 'finished' : 'idle') : status)

const newestFirst = (a: SessionInfo, b: SessionInfo) => b.createdAt - a.createdAt

function useOffline(): (machineId?: string) => boolean {
  const machines = useStore((s) => s.machines)
  return (machineId?: string) => !!machineId && !machineUp(machines[machineId])
}

/** Open the prompt bubble beside a control (the project's New session button). */
function openComposer(projectId: string, el: Element | null): void {
  const s = useStore.getState()
  const project = s.projects[projectId]
  // No prompt bubble while the window is read-only or the project's machine is offline.
  if (!el || !project || lockReason(s, project.machineId)) return
  const r = el.getBoundingClientRect()
  s.setComposer({ projectId, left: r.left, right: r.right, top: r.top })
}

// ---------- rows ----------

function AgentRow({ agent, offline, machineId }: { agent: AgentInfo; offline: boolean; machineId?: string }) {
  const tint = useTint(machineId)
  const status = shown(agent.status, offline)
  return (
    <button className={`row row-agent${tint}${status === 'finished' ? ' is-finished' : ''}${offline ? ' is-offline' : ''}`} title={`${statusLabel(status)}: ${agent.description}`} onClick={() => useStore.getState().openPanel('agent', agent.id)}>
      <Glyph status={status} size={8} />
      <span className="row-text">
        <span className="row-title">{agent.description}</span>
      </span>
      {agent.subagentType && <span className="row-kind">{agent.subagentType}</span>}
    </button>
  )
}

/** One session: its status, title, model and GitHub identity, the machine it runs on, and its subagents while they run. */
function SessionRow({ session, agents, offline, nested }: { session: SessionInfo; agents: AgentInfo[]; offline: boolean; nested?: boolean }) {
  const model = useModelLabel(session.model, session.machineId)
  const tint = useTint(session.machineId)
  const status = shown(session.status, offline)
  const optimize = session.kind === 'optimize'
  // Only a handed-off optimize step fades away; a failed or refused one stays so it can be opened.
  const leaving = optimize && !!session.handedOff
  const open = (e: React.MouseEvent) => {
    e.preventDefault()
    useStore.getState().openPanel('session', session.id)
  }
  return (
    <>
      <button
        className={`row${nested ? ' is-nested' : ''}${tint}${status === 'finished' ? ' is-finished' : ''}${leaving ? ' is-leaving' : ''}${offline ? ' is-offline' : ''}`}
        title={`${statusLabel(status)}: ${session.title}`}
        onClick={open}
        onContextMenu={open}
      >
        <Glyph status={status} size={12} variant={optimize && status !== 'input' && status !== 'approval' ? 'optimize' : 'default'} />
        <span className="row-text">
          <span className="row-title">{session.title.split('\n')[0]}</span>
          <span className="row-sub">
            {optimize ? <span className="mono">/optimize-prompt</span> : <span>{session.effort ? `${model} · ${EFFORT_LABELS[session.effort].toLowerCase()}` : model}</span>}
            {session.kind === 'config' && <span>config change</span>}
            {session.identity && <span className={`identity${session.identity.login ? '' : ' is-none'}`}>{session.identity.login ? `@${session.identity.login}` : 'no GitHub account'}</span>}
          </span>
        </span>
        <MachineTag machineId={session.machineId} />
        <span className="row-time">{when(session.createdAt)}</span>
      </button>
      {agents.map((ag) => (
        <AgentRow key={ag.id} agent={ag} offline={offline} machineId={session.machineId} />
      ))}
    </>
  )
}

function SessionRows({ sessions, agents, nested }: { sessions: SessionInfo[]; agents: Map<string, AgentInfo[]>; nested?: boolean }) {
  const offline = useOffline()
  return (
    <>
      {sessions.map((x) => (
        <SessionRow key={x.id} session={x} agents={agents.get(x.id) ?? []} offline={offline(x.machineId)} nested={nested} />
      ))}
    </>
  )
}

// ---------- groups ----------

/** A fold button with the group's glyph and name. */
function GroupFold({ open, onToggle, children, title }: { open: boolean; onToggle: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button className={`group-fold${open ? ' is-open' : ''}`} onClick={onToggle} aria-expanded={open} title={title ?? (open ? 'Fold' : 'Show')}>
      <IconChevron />
      {children}
    </button>
  )
}

/**
 * A project: its header carries the project's actions (changes, CLAUDE.md, folder, terminal,
 * remove, New session) and takes dropped files for .claude-references; its sessions follow, newest first.
 */
function ProjectGroup({ project, sessions, agents }: { project: Project; sessions: SessionInfo[]; agents: Map<string, AgentInfo[]> }) {
  const stats = useStore((s) => s.git[project.id])
  const machine = useStore((s) => (project.machineId ? s.machines[project.machineId] : undefined))
  const lock = useLock(project.machineId)
  const tint = useTint(project.machineId)
  const offline = !!project.machineId && !machineUp(machine)
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const newButton = useRef<HTMLButtonElement>(null)
  const status = shown(rollup(sessions.map((x) => x.status)), offline)
  const busy = sessions.some((x) => x.status !== 'finished')
  const clean = !stats || (stats.added === 0 && stats.removed === 0)
  // Terminals on a remote machine need its own switch.
  const terminals = !machine || machine.terminals

  // Files dropped on a project are saved in its .claude-references folder (on its own machine).
  const [dropNote, setDropNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(noteTimer.current), [])
  const showNote = (note: string) => {
    clearTimeout(noteTimer.current)
    setDropNote(note)
    noteTimer.current = setTimeout(() => setDropNote(null), DROP_NOTE_MS * 2)
  }
  const drop = useFileDrop(!lock, (files) => {
    clearTimeout(noteTimer.current)
    setDropNote(`adding ${files.length === 1 ? files[0].name : `${files.length} files`}…`)
    void uploadReferences(project.id, files).then(({ added, errors }) => {
      const n = added.length
      setDropNote([n ? `${n} file${n === 1 ? '' : 's'} added to .claude-references` : '', ...errors].filter(Boolean).join(' · '))
      noteTimer.current = setTimeout(() => setDropNote(null), errors.length ? DROP_NOTE_MS * 2 : DROP_NOTE_MS)
    })
  })

  let finished = 0
  const short = sessions.filter((x) => x.status !== 'finished' || finished++ < FINISHED_SHOWN)
  const hidden = sessions.length - short.length
  const visible = all ? sessions : short

  return (
    <section className={`group${offline ? ' is-offline' : ''}${drop.over ? ' is-drop-over' : ''}`} {...drop.props}>
      <header
        className={`group-head project-head${tint}`}
        title={lock ?? `${statusLabel(status)}\nRight-click or New session to start one\nDrop files here to add them to .claude-references`}
        onContextMenu={(e) => {
          e.preventDefault()
          openComposer(project.id, newButton.current)
        }}
      >
        <GroupFold open={open} onToggle={() => setOpen((o) => !o)}>
          <Glyph status={status} size={14} />
          <span className="group-title">{project.name}</span>
        </GroupFold>
        <MachineTag machineId={project.machineId} />
        <span className="group-path" title={project.path}>
          {project.path}
        </span>
        <span className="spacer" />
        <div className="group-actions">
          {stats?.isRepo !== false && (
            <button className={`diff-counts${clean ? ' is-clean' : ''}`} title="Branch and uncommitted changes" onClick={() => useStore.getState().openPanel('diff', project.id)}>
              {stats?.branch && <span className="branch">{stats.branch}</span>}
              <span>+{nf.format(stats?.added ?? 0)}</span>
              <span className="del">−{nf.format(stats?.removed ?? 0)}</span>
            </button>
          )}
          <button className="icon-btn" title="CLAUDE.md" onClick={() => useStore.getState().openPanel('claudemd', project.id)}>
            <IconDoc />
          </button>
          {!project.machineId && (
            <button className="icon-btn" title={FILE_MANAGER} onClick={() => void api.openProjectFolder(project.id).then((err) => err && showNote(err), (err) => showNote(cleanError(err)))}>
              <IconOpenFolder />
            </button>
          )}
          {terminals && (
            <button className="icon-btn" title="Terminal in this project" disabled={!!lock} onClick={() => useStore.getState().openTerminal(project.id, project.machineId)}>
              <IconTerminal />
            </button>
          )}
          <button
            className="icon-btn reveal"
            title={busy ? 'Remove from Symphony (once no session is running)' : 'Remove from Symphony (the folder is not touched)'}
            disabled={busy || !!lock}
            onClick={() => void api.removeProject(project.id)}
          >
            <IconTrash />
          </button>
          <button ref={newButton} className="btn small" disabled={!!lock} title={lock ?? `New session in ${project.name}`} onClick={(e) => openComposer(project.id, e.currentTarget)}>
            <IconPlus size={12} />
            New session
          </button>
        </div>
      </header>
      {dropNote && <div className="group-note">{dropNote}</div>}
      {open ? (
        <div className="rows">
          {!sessions.length && <div className="rows-empty">No sessions yet. New session, or right-click the project.</div>}
          <SessionRows sessions={visible} agents={agents} />
          {hidden > 0 && (
            <button className="rows-more" onClick={() => setAll((a) => !a)}>
              {all ? 'Show fewer' : `Show ${hidden} earlier`}
            </button>
          )}
        </div>
      ) : (
        sessions.length > 0 && <div className="group-note">{sessions.length} folded</div>
      )}
    </section>
  )
}

function loopSub(l: LoopInfo): string {
  const at = l.steps.find((s) => s.id === l.current)
  switch (l.state) {
    case 'draft':
      return `${l.steps.length} steps`
    case 'optimizing':
      return 'improving prompts'
    case 'running':
      return at?.title ?? ''
    case 'waiting':
      return `your review · ${at?.title ?? ''}`
    case 'paused':
      return `paused at ${at?.title ?? ''}`
    case 'done':
      return `done · ${l.runs} runs`
    case 'stopped':
      return 'stopped'
  }
}

/** Step markers: circles for agent steps, squares for human steps; the current one is bone white. */
function StepPips({ loop }: { loop: LoopInfo }) {
  return (
    <span className="pips">
      {loop.steps.map((s) => (
        <span key={s.id} className={`pip ${s.kind}${s.id === loop.current ? ' is-current' : ''}`} title={s.title} />
      ))}
    </span>
  )
}

/** A loop, with the sessions it shows right now (its running step, or prompts being improved) under it. */
function LoopRow({ loop, sessions, agents }: { loop: LoopInfo; sessions: SessionInfo[]; agents: Map<string, AgentInfo[]> }) {
  const all = useStore((s) => s.sessions)
  const machine = useStore((s) => (loop.machineId ? s.machines[loop.machineId] : undefined))
  const tint = useTint(loop.machineId)
  const offline = !!loop.machineId && !machineUp(machine)
  const status = shown(loopStatus(loop, all), offline)
  return (
    <>
      <button
        className={`row row-loop${tint}${status === 'finished' ? ' is-finished' : ''}${offline ? ' is-offline' : ''}`}
        title={`${statusLabel(status)}: ${loop.name}`}
        onClick={() => useStore.getState().openPanel('loop', loop.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          useStore.getState().openPanel('loop', loop.id)
        }}
      >
        <Glyph status={status} size={12} variant="loop" />
        <span className="row-text">
          <span className="row-title">{loop.name}</span>
          <span className="row-sub">
            <StepPips loop={loop} />
            <span>{loopSub(loop)}</span>
          </span>
        </span>
        <MachineTag machineId={loop.machineId} />
        <span className="row-time">{when(loop.createdAt)}</span>
      </button>
      <SessionRows sessions={sessions} agents={agents} nested />
    </>
  )
}

/** A group without project actions: the workspace's loops, or sessions outside any project. */
function PlainGroup({ title, hint, glyph, children }: { title: string; hint: string; glyph: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="group">
      <header className="group-head" title={hint}>
        <GroupFold open={open} onToggle={() => setOpen((o) => !o)}>
          {glyph}
          <span className="group-title">{title}</span>
        </GroupFold>
      </header>
      {open && <div className="rows">{children}</div>}
    </section>
  )
}

// ---------- the list ----------

/**
 * The selected workspace as a chat history: its notes, then each of its projects with its
 * sessions, its loops, and the sessions that belong to no project or loop (shown in every workspace).
 */
export function SessionList() {
  const projects = useStore((s) => s.projects)
  const sessions = useStore((s) => s.sessions)
  const agentMap = useStore((s) => s.agents)
  const loops = useStore((s) => s.loops)
  const notes = useStore((s) => s.notes)
  const workspaces = useStore((s) => s.workspaces)
  const locked = useStore((s) => !!s.control)

  const view = useMemo(() => {
    const s = { projects, loops, workspaces }
    const active = workspaces.active
    // Earlier runs of loop steps stay out of the list; the loop panel lists them.
    const live = Object.values(sessions)
      .filter((x) => !x.archived)
      .sort(newestFirst)
    const byProject = new Map<string, SessionInfo[]>()
    const byLoop = new Map<string, SessionInfo[]>()
    const other: SessionInfo[] = []
    for (const x of live) {
      const ws = sessionWorkspace(s, x)
      if (ws !== undefined && ws !== active) continue
      if (x.projectId && projects[x.projectId]) byProject.set(x.projectId, [...(byProject.get(x.projectId) ?? []), x])
      else if (loops[x.anchorId]) byLoop.set(x.anchorId, [...(byLoop.get(x.anchorId) ?? []), x])
      else if (x.loopId && loops[x.loopId]) byLoop.set(x.loopId, [...(byLoop.get(x.loopId) ?? []), x])
      else other.push(x)
    }
    const agents = new Map<string, AgentInfo[]>()
    for (const ag of Object.values(agentMap)) agents.set(ag.sessionId, [...(agents.get(ag.sessionId) ?? []), ag])
    return {
      projects: Object.values(projects).filter((p) => inWorkspace(s, p.id)),
      loops: Object.values(loops)
        .filter((l) => inWorkspace(s, l.id))
        .sort((a, b) => b.createdAt - a.createdAt),
      notes: Object.values(notes).filter((n) => inWorkspace(s, n.id)),
      byProject,
      byLoop,
      other,
      agents,
      count: live.filter((x) => {
        const ws = sessionWorkspace(s, x)
        return ws === undefined || ws === active
      }).length
    }
  }, [projects, sessions, agentMap, loops, notes, workspaces])

  const name = workspaces.list.find((w) => w.id === workspaces.active)?.name ?? ''

  return (
    <main className="list">
      <header className="list-head">
        <h1 className="list-title">{name}</h1>
        <span className="list-meta">
          {view.projects.length} project{view.projects.length === 1 ? '' : 's'} · {view.count} session{view.count === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button className="btn ghost small" disabled={locked} title="A sticky note in this workspace" onClick={createNote}>
          <IconNote size={13} />
          New note
        </button>
      </header>
      <div className="list-scroll">
        <div className="list-column">
          <NotesSection notes={view.notes} />
          {!view.projects.length && (
            <div className="empty-hint">
              <strong>Add a project folder</strong> with the folder button under This PC in the sidebar, or drop one anywhere. Then start a session with New session on the project.
            </div>
          )}
          {view.projects.map((p) => (
            <ProjectGroup key={p.id} project={p} sessions={view.byProject.get(p.id) ?? []} agents={view.agents} />
          ))}
          {view.loops.length > 0 && (
            <PlainGroup title="Loops" hint="Loops in this workspace; the loop button on a machine in the sidebar makes a new one" glyph={<Glyph status="idle" size={12} variant="loop" />}>
              {view.loops.map((l) => (
                <LoopRow key={l.id} loop={l} sessions={view.byLoop.get(l.id) ?? []} agents={view.agents} />
              ))}
            </PlainGroup>
          )}
          {view.other.length > 0 && (
            <PlainGroup title="~/.claude" hint="Sessions outside any project, such as changes to user skills and MCP servers. Listed in every workspace." glyph={<Glyph status="idle" size={12} variant="hub" />}>
              <SessionRows sessions={view.other} agents={view.agents} />
            </PlainGroup>
          )}
        </div>
      </div>
    </main>
  )
}
