import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { EFFORT_LABELS, type AgentInfo, type GitStats, type McpInfo, type NodeStatus, type Project, type SessionInfo, type SkillInfo } from '@shared/types'
import { api, useStore } from '../store'
import { Glyph, statusLabel } from './Glyph'
import { IconDoc, IconTerminal, IconTrash } from './icons'

const nf = new Intl.NumberFormat('en-US')

/** Invisible anchors on every side; the graph picks the pair that faces the other node. */
function Handles() {
  return (
    <>
      <Handle id="tl" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="tr" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="sr" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="sl" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="sb" type="source" position={Position.Bottom} isConnectable={false} />
    </>
  )
}

function stateClass(status: NodeStatus, leaving?: boolean) {
  return `${status === 'finished' ? ' is-finished' : ''}${leaving ? ' is-leaving' : ''}`
}

export function useModelLabel(value: string): string {
  const models = useStore((s) => s.models)
  return models.find((m) => m.value === value)?.label ?? value
}

// ---------- project ----------

export type ProjectNodeType = Node<{ project: Project; status: NodeStatus; stats?: GitStats; busy: boolean }, 'project'>

export function ProjectNode({ data }: NodeProps<ProjectNodeType>) {
  const { project, status, stats, busy } = data
  const openPanel = useStore((s) => s.openPanel)
  const clean = !stats || (stats.added === 0 && stats.removed === 0)
  return (
    <div className={`node node-project${stateClass(status)}`} title={statusLabel(status)}>
      <Glyph status={status} size={30} />
      <div className="node-text">
        <span className="node-title">{project.name}</span>
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
          <button
            className="icon-btn nodrag"
            title="Terminal in this project"
            onClick={(e) => {
              e.stopPropagation()
              useStore.getState().openTerminal(project.id)
            }}
          >
            <IconTerminal />
          </button>
          <button
            className="icon-btn nodrag reveal"
            title="Remove from Symphony (the folder is not touched)"
            disabled={busy}
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

export type SessionNodeType = Node<{ session: SessionInfo; leaving: boolean }, 'session'>

export function SessionNode({ data }: NodeProps<SessionNodeType>) {
  const { session, leaving } = data
  const model = useModelLabel(session.model)
  const optimize = session.kind === 'optimize'
  return (
    <div className={`node node-session${stateClass(session.status, leaving)}`} title={`${statusLabel(session.status)}: ${session.title}`}>
      <Glyph status={session.status} size={16} variant={optimize && session.status !== 'input' && session.status !== 'approval' ? 'optimize' : 'default'} />
      <div className="node-text">
        <span className="node-title">{session.title.split('\n')[0]}</span>
        <span className="node-sub">
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

// ---------- agent ----------

export type AgentNodeType = Node<{ agent: AgentInfo }, 'agent'>

export function AgentNode({ data }: NodeProps<AgentNodeType>) {
  const { agent } = data
  return (
    <div className={`node node-agent${stateClass(agent.status)}`} title={`${statusLabel(agent.status)}: ${agent.description}`}>
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

export type HubNodeType = Node<{ open: boolean; skills: number; mcp: number }, 'hub'>

export function HubNode({ data }: NodeProps<HubNodeType>) {
  const gh = useStore((s) => s.gh)
  const accounts = Object.entries(gh.hosts).flatMap(([host, list]) => list.filter((a) => a.active).map((a) => (host === 'github.com' ? a.login : `${a.login}@${host}`)))
  return (
    <div className="node node-hub" title={data.open ? 'Hide user skills and MCP servers' : 'Show user skills and MCP servers'}>
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
              onClick={(e) => {
                e.stopPropagation()
                useStore.getState().openPanel('login', 'github')
                void api.ghLogin()
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

export type SkillNodeType = Node<{ skill: SkillInfo }, 'skill'>

export function SkillNode({ data }: NodeProps<SkillNodeType>) {
  const { skill } = data
  return (
    <div className="node node-skill" title={skill.description || skill.name}>
      <Glyph status="idle" size={8} />
      <div className="node-text">
        <span className="node-title">{skill.name}</span>
      </div>
      <Handles />
    </div>
  )
}

// ---------- MCP server ----------

export type McpNodeType = Node<{ mcp: McpInfo }, 'mcp'>

const MCP_STATUS: Record<McpInfo['status'], NodeStatus> = {
  connected: 'idle',
  pending: 'working',
  'needs-auth': 'input',
  failed: 'idle',
  disabled: 'finished'
}

export function McpNode({ data }: NodeProps<McpNodeType>) {
  const { mcp } = data
  const status = MCP_STATUS[mcp.status]
  const titles: Record<McpInfo['status'], string> = {
    connected: 'Connected',
    pending: 'Connecting',
    'needs-auth': 'Needs you to authenticate',
    failed: `Failed${mcp.error ? `: ${mcp.error}` : ''}`,
    disabled: 'Disabled'
  }
  return (
    <div className={`node node-mcp${stateClass(status)}`} title={`${mcp.name}: ${titles[mcp.status]}`}>
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

export const nodeTypes = {
  project: ProjectNode,
  session: SessionNode,
  agent: AgentNode,
  hub: HubNode,
  skill: SkillNode,
  mcp: McpNode
}
