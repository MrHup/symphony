import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EFFORT_LABELS, type AgentInfo, type GitStats, type LoopInfo, type MachineState, type McpInfo, type NodeStatus, type Note, type Project, type SessionInfo, type SkillInfo } from '@shared/types'
import { api, clock, machineConfig, useLock, useStore } from '../store'
import { Glyph, statusLabel } from './Glyph'
import { IconAutoApprove, IconBattery, IconDoc, IconFolder, IconLoop, IconTerminal, IconTrash } from './icons'
import { Markdown } from './Markdown'

const nf = new Intl.NumberFormat('en-US')

/** Invisible anchors on every side; the graph picks the pair that faces the other node. */
function Handles() {
  return (
    <>
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} />
      {/* Under the glyph, so children stacked below hang from it in a straight line. */}
      <Handle id="sb" type="source" position={Position.Bottom} isConnectable={false} style={{ left: 14 }} />
    </>
  )
}

function stateClass(status: NodeStatus, leaving?: boolean, offline?: boolean) {
  return `${status === 'finished' ? ' is-finished' : ''}${leaving ? ' is-leaving' : ''}${offline ? ' is-offline' : ''}`
}

export function useModelLabel(value: string, machineId?: string): string {
  const models = useStore((s) => machineConfig(s, machineId).models)
  return models.find((m) => m.value === value)?.label ?? value
}

// ---------- project ----------

export type ProjectNodeType = Node<{ project: Project; status: NodeStatus; stats?: GitStats; busy: boolean; offline?: boolean; machine?: MachineState }, 'project'>

export function ProjectNode({ data }: NodeProps<ProjectNodeType>) {
  const { project, status, stats, busy, offline, machine } = data
  const openPanel = useStore((s) => s.openPanel)
  const lock = useLock(project.machineId)
  const clean = !stats || (stats.added === 0 && stats.removed === 0)
  // Terminals on a remote machine need its own switch.
  const terminals = !machine || machine.terminals
  return (
    <div className={`node node-project${stateClass(status, false, offline)}`} title={lock ?? statusLabel(status)}>
      <Glyph status={status} size={30} />
      <div className="node-text">
        <span className="node-title">{project.name}</span>
        {machine && <span className="node-machine">{machine.name}</span>}
        <span className="node-path" title={project.path}>
          {project.path}
        </span>
        <div className="node-actions">
          {stats?.isRepo !== false && (
            <button
              className={`diff-counts nodrag${clean ? ' is-clean' : ''}`}
              title="Uncommitted changes"
              onClick={(e) => {
                e.stopPropagation()
                openPanel('diff', project.id)
              }}
            >
              <span>+{nf.format(stats?.added ?? 0)}</span>
              <span className="del">−{nf.format(stats?.removed ?? 0)}</span>
            </button>
          )}
          <button
            className="icon-btn nodrag"
            title="CLAUDE.md"
            onClick={(e) => {
              e.stopPropagation()
              openPanel('claudemd', project.id)
            }}
          >
            <IconDoc />
          </button>
          {terminals && (
            <button
              className="icon-btn nodrag"
              title="Terminal in this project"
              disabled={!!lock}
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().openTerminal(project.id, project.machineId)
              }}
            >
              <IconTerminal />
            </button>
          )}
          <button
            className="icon-btn nodrag"
            title="New loop on this project"
            disabled={!!lock}
            onClick={(e) => {
              e.stopPropagation()
              useStore.getState().newLoop(project.id)
            }}
          >
            <IconLoop />
          </button>
          <button
            className="icon-btn nodrag reveal"
            title="Remove from Symphony (the folder is not touched)"
            disabled={busy || !!lock}
            onClick={(e) => {
              e.stopPropagation()
              void api.removeProject(project.id)
            }}
          >
            <IconTrash />
          </button>
        </div>
      </div>
      <Handles />
    </div>
  )
}

// ---------- session ----------

export type SessionNodeType = Node<{ session: SessionInfo; leaving: boolean; offline?: boolean }, 'session'>

export function SessionNode({ data }: NodeProps<SessionNodeType>) {
  const { session, leaving, offline } = data
  const model = useModelLabel(session.model, session.machineId)
  const optimize = session.kind === 'optimize'
  return (
    <div className={`node node-session${stateClass(session.status, leaving, offline)}`} title={`${statusLabel(session.status)}: ${session.title}`}>
      <Glyph status={session.status} size={16} variant={optimize && session.status !== 'input' && session.status !== 'approval' ? 'optimize' : 'default'} />
      <div className="node-text">
        <span className="node-title">{session.title.split('\n')[0]}</span>
        <span className="node-sub">
          {session.kind === 'loop' && session.loopStep !== undefined && <span>step {session.loopStep + 1}</span>}
          {optimize ? <span style={{ fontFamily: 'var(--mono)' }}>/optimize-prompt</span> : <span>{session.effort ? `${model} · ${EFFORT_LABELS[session.effort].toLowerCase()}` : model}</span>}
          {session.identity && (
            <span className={`identity${session.identity.login ? '' : ' is-none'}`}>{session.identity.login ? `@${session.identity.login}` : 'no GitHub account'}</span>
          )}
        </span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- loop ----------

export type LoopNodeType = Node<{ loop: LoopInfo; status: NodeStatus; offline?: boolean }, 'loop'>

function loopSub(l: LoopInfo): string {
  const at = l.current !== null ? l.steps[l.current] : undefined
  switch (l.state) {
    case 'draft':
      return `${l.steps.length} steps`
    case 'optimizing':
      return 'improving prompts'
    case 'running':
      return `step ${(l.current ?? 0) + 1} of ${l.steps.length} · ${at?.title ?? ''}`
    case 'waiting':
      return `your review · ${at?.title ?? ''}`
    case 'paused':
      return `paused at step ${(l.current ?? 0) + 1}`
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
      {loop.steps.map((s, i) => {
        const cls = `pip ${s.kind}${i === loop.current ? ' is-current' : loop.current !== null && i < loop.current ? ' is-past' : ''}`
        return <span key={s.id} className={cls} title={`${i + 1}. ${s.title}`} />
      })}
    </span>
  )
}

export function LoopNode({ data }: NodeProps<LoopNodeType>) {
  const { loop, status, offline } = data
  return (
    <div className={`node node-loop${stateClass(status, false, offline)}`} title={`${statusLabel(status)}: ${loop.name}`}>
      <Glyph status={status} size={20} variant="loop" />
      <div className="node-text">
        <span className="node-title">{loop.name}</span>
        <span className="node-sub">
          <StepPips loop={loop} />
          <span>{loopSub(loop)}</span>
        </span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- agent ----------

export type AgentNodeType = Node<{ agent: AgentInfo; offline?: boolean }, 'agent'>

export function AgentNode({ data }: NodeProps<AgentNodeType>) {
  const { agent, offline } = data
  return (
    <div className={`node node-agent${stateClass(agent.status, false, offline)}`} title={`${statusLabel(agent.status)}: ${agent.description}`}>
      <Glyph status={agent.status} size={10} />
      <div className="node-text">
        <span className="node-title">{agent.description}</span>
        {agent.subagentType && <span className="node-sub">{agent.subagentType}</span>}
      </div>
      <Handles />
    </div>
  )
}

// ---------- user hub (~/.claude) ----------

export type HubNodeType = Node<{ open: boolean; skills: number; mcp: number; machineId?: string; offline?: boolean }, 'hub'>

const NO_GH = { installed: false, hosts: {} }

export function HubNode({ data }: NodeProps<HubNodeType>) {
  // Each machine has its own ~/.claude and its own gh login.
  const gh = useStore((s) => (data.machineId ? (s.machines[data.machineId]?.gh ?? NO_GH) : s.gh))
  const lock = useLock(data.machineId)
  const accounts = Object.entries(gh.hosts).flatMap(([host, list]) => list.filter((a) => a.active).map((a) => (host === 'github.com' ? a.login : `${a.login}@${host}`)))
  return (
    <div className={`node node-hub${data.offline ? ' is-offline' : ''}`} title={data.open ? 'Hide user skills and MCP servers' : 'Show user skills and MCP servers'}>
      <Glyph status="idle" size={22} variant="hub" />
      <div className="node-text">
        <span className="node-title">~/.claude</span>
        <span className="node-sub">
          <span>
            {data.skills} skills · {data.mcp} MCP
          </span>
          {!gh.installed ? (
            <span className="identity is-none">gh not installed</span>
          ) : accounts.length ? (
            <span className="identity">{accounts.map((a) => `@${a}`).join(' ')}</span>
          ) : (
            <button
              className="identity is-none nodrag"
              disabled={!!lock}
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().openPanel('login', data.machineId ?? 'local')
                void api.ghLogin(data.machineId)
              }}
            >
              sign in to GitHub
            </button>
          )}
        </span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- skill ----------

export type SkillNodeType = Node<{ skill: SkillInfo; offline?: boolean }, 'skill'>

export function SkillNode({ data }: NodeProps<SkillNodeType>) {
  const { skill, offline } = data
  return (
    <div className={`node node-skill${offline ? ' is-offline' : ''}`} title={skill.description || skill.name}>
      <Glyph status="idle" size={8} />
      <div className="node-text">
        <span className="node-title">{skill.name}</span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- MCP server ----------

export type McpNodeType = Node<{ mcp: McpInfo; offline?: boolean }, 'mcp'>

const MCP_STATUS: Record<McpInfo['status'], NodeStatus> = {
  connected: 'idle',
  pending: 'working',
  'needs-auth': 'input',
  failed: 'idle',
  disabled: 'finished'
}

export function McpNode({ data }: NodeProps<McpNodeType>) {
  const { mcp, offline } = data
  const status = offline ? 'idle' : MCP_STATUS[mcp.status]
  const titles: Record<McpInfo['status'], string> = {
    connected: 'Connected',
    pending: 'Connecting',
    'needs-auth': 'Needs you to authenticate',
    failed: `Failed${mcp.error ? `: ${mcp.error}` : ''}`,
    disabled: 'Disabled'
  }
  return (
    <div className={`node node-mcp${stateClass(status, false, offline)}`} title={`${mcp.name}: ${titles[mcp.status]}`}>
      <Glyph status={status} size={11} variant={mcp.status === 'failed' ? 'failed' : 'default'} />
      <div className="node-text">
        <span className="node-title" style={mcp.status === 'connected' ? { color: 'var(--bone)' } : undefined}>
          {mcp.name}
        </span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- machine ----------

export type MachineNodeType = Node<{ machine?: MachineState; local?: boolean }, 'machine'>

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

function machineSub(m: MachineState): string {
  switch (m.status) {
    case 'online':
      return PLATFORM[m.platform] ?? m.platform
    case 'reconnecting':
      return 'reconnecting'
    case 'pairing':
      return 'wants to pair · click to compare the code'
    case 'asleep':
      return `asleep · since ${clock(m.since)}`
    case 'quit':
      return `quit · ${clock(m.since)}`
    case 'offline':
      return `offline · since ${clock(m.since)}`
  }
}

/** The root of one machine's part of the graph. Offline is a broken ring and an outline, never the signal color. */
export function MachineNode({ data }: NodeProps<MachineNodeType>) {
  const m = data.machine
  const lock = useLock(m?.id)
  if (!m) {
    return (
      <div className="node node-machine" title="This machine">
        <Glyph status="idle" size={24} variant="hub" />
        <div className="node-text">
          <span className="node-title">This PC</span>
        </div>
        <Handles />
      </div>
    )
  }
  const up = m.status === 'online' || m.status === 'reconnecting'
  const status: NodeStatus = m.status === 'pairing' ? 'input' : m.status === 'reconnecting' ? 'working' : 'idle'
  const battery = m.health && !m.health.charging && m.health.battery !== null ? m.health.battery : null
  return (
    <div className={`node node-machine${up || m.status === 'pairing' ? '' : ' is-down'}`} title={`${PLATFORM[m.platform] ?? m.platform}${m.appVersion ? ` · Symphony ${m.appVersion}` : ''}`}>
      <Glyph status={status} size={24} variant={up || m.status === 'pairing' ? 'hub' : 'failed'} />
      <div className="node-text">
        <span className="node-title">{m.name}</span>
        <span className="node-sub">
          <span>{machineSub(m)}</span>
          {up && battery !== null && (
            <span className="battery" title={`On battery, ${battery}%`}>
              <IconBattery level={battery / 100} />
              {battery}%{battery < 15 && ' · battery low · may sleep'}
            </span>
          )}
          {up && m.health?.lowPower && <span>low power mode</span>}
        </span>
        {m.outdated && <span className="node-sub">update Symphony on this machine</span>}
        {m.status !== 'pairing' && (
          <div className="node-actions">
            <button
              className={`icon-btn nodrag${m.autoApprove ? ' is-on' : ''}`}
              aria-pressed={m.autoApprove}
              disabled={!!lock}
              title={m.autoApprove ? `Auto-approve is on for ${m.name}. Click to turn off.` : `Auto-approve on ${m.name}: allow permission prompts without asking`}
              onClick={(e) => {
                e.stopPropagation()
                void api.setAutoApprove(!m.autoApprove, m.id)
              }}
            >
              <IconAutoApprove size={14} />
            </button>
            <button
              className="icon-btn nodrag"
              disabled={!!lock}
              title={`Add a project from the folders ${m.name} shares`}
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().openPanel('folders', m.id)
              }}
            >
              <IconFolder />
            </button>
            {m.terminals && (
              <button
                className="icon-btn nodrag"
                disabled={!!lock}
                title={`Terminal in the home folder of ${m.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  useStore.getState().openTerminal(null, m.id)
                }}
              >
                <IconTerminal />
              </button>
            )}
          </div>
        )}
      </div>
      <Handles />
    </div>
  )
}

// ---------- sticky note ----------

export type NoteNodeType = Node<{ note: Note }, 'note'>

const NOTE_SAVE_MS = 500

/** Markdown on a sticky note. Click to edit; leaving the editor shows it rendered again, and drops a note left empty. */
export function NoteNode({ data }: NodeProps<NoteNodeType>) {
  const { note } = data
  const lock = useLock()
  // A new note opens ready to type.
  const [editing, setEditing] = useState(!note.text && !lock)
  const [draft, setDraft] = useState(note.text)
  const area = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // A new node stays hidden until React Flow has measured it, and a hidden field cannot take focus.
  useEffect(() => {
    if (!editing) return
    let frames = 0
    let raf = 0
    const focus = () => {
      const el = area.current
      if (!el) return
      el.focus()
      if (document.activeElement !== el && frames++ < 30) raf = requestAnimationFrame(focus)
      else el.setSelectionRange(el.value.length, el.value.length)
    }
    focus()
    return () => cancelAnimationFrame(raf)
  }, [editing])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, editing])

  useEffect(() => () => clearTimeout(timer.current), [])

  const finish = () => {
    clearTimeout(timer.current)
    setEditing(false)
    if (!draft.trim()) void api.noteDelete(note.id)
    else if (draft !== note.text) void api.noteUpdate(note.id, draft)
  }

  return (
    <div
      className={`node-note${editing ? ' is-editing' : ''}`}
      title={lock ?? undefined}
      onClick={(e) => {
        if (editing || lock || (e.target as Element).closest('a, button')) return
        setDraft(note.text)
        setEditing(true)
      }}
    >
      {editing ? (
        <textarea
          ref={area}
          className="nodrag nowheel"
          value={draft}
          placeholder="Write in markdown"
          onChange={(e) => {
            const text = e.target.value
            setDraft(text)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => void api.noteUpdate(note.id, text), NOTE_SAVE_MS)
          }}
          onBlur={finish}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') area.current?.blur()
          }}
        />
      ) : note.text ? (
        <Markdown text={note.text} />
      ) : (
        <span className="note-empty">Empty note</span>
      )}
      <button
        className="icon-btn nodrag reveal"
        title="Delete note"
        disabled={!!lock}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          clearTimeout(timer.current)
          void api.noteDelete(note.id)
        }}
      >
        <IconTrash />
      </button>
    </div>
  )
}

export const nodeTypes = {
  machine: MachineNode,
  project: ProjectNode,
  session: SessionNode,
  agent: AgentNode,
  loop: LoopNode,
  hub: HubNode,
  skill: SkillNode,
  mcp: McpNode,
  note: NoteNode
}
