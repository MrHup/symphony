import { applyNodeChanges, ReactFlow, useReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { USER_HUB_ID, type Point } from '@shared/types'
import { api, loopStatus, needsUser, rollup, useStore } from '../store'
import { nodeTypes } from './nodes'

const SESSION_DX = 400
const SESSION_DY = 58
const AGENT_DX = 300
const AGENT_DY = 34
const SKILL_DY = 28
const SKILL_COL_W = 215
const SKILL_ROWS = 14
const LOOP_DY = 64
const LOOP_SESSION_DX = 36
const LOOP_SESSION_DY = 46

type State = ReturnType<typeof useStore.getState>

/** Compute every node and edge from app state. `moved` holds positions the user dragged this run. */
function layout(s: State, moved: Record<string, Point>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const pos = new Map<string, Point>()
  const at = (id: string, fallback: Point) => moved[id] ?? fallback

  // Earlier runs of loop steps stay off the graph; the loop panel lists them.
  const sessions = Object.values(s.sessions)
    .filter((x) => !x.archived)
    .sort((a, b) => a.createdAt - b.createdAt)
  const loops = Object.values(s.loops).sort((a, b) => a.createdAt - b.createdAt)
  const loopIds = new Set(loops.map((l) => l.id))
  const edge = (source: string, target: string, signal: boolean, faded = false) =>
    edges.push({ id: `${source}->${target}`, source, target, className: signal ? 'edge-signal' : faded ? 'edge-faded' : undefined, selectable: false, focusable: false })

  // Hub with user-level skills and MCP servers.
  const hub = at(USER_HUB_ID, s.hubPosition)
  pos.set(USER_HUB_ID, hub)
  const userSkills = s.skills.filter((k) => !k.projectId)
  const userMcp = s.mcp.filter((m) => !m.projectId)
  nodes.push({ id: USER_HUB_ID, type: 'hub', position: hub, data: { open: s.hubOpen, skills: userSkills.length, mcp: userMcp.length } })
  const rows = Math.min(SKILL_ROWS, Math.max(1, userSkills.length))
  const cols = Math.ceil(userSkills.length / SKILL_ROWS)
  const skillsLeftEdge = hub.x - 240 - (cols - 1) * SKILL_COL_W
  if (s.hubOpen) {
    userSkills.forEach((k, i) => {
      const c = Math.floor(i / SKILL_ROWS)
      const r = i % SKILL_ROWS
      const p = at(k.id, { x: hub.x - 240 - c * SKILL_COL_W, y: hub.y + 6 + (r - (rows - 1) / 2) * SKILL_DY })
      pos.set(k.id, p)
      nodes.push({ id: k.id, type: 'skill', position: p, data: { skill: k } })
      edge(USER_HUB_ID, k.id, false, true)
    })
    userMcp.forEach((m, i) => {
      const p = at(m.id, { x: hub.x + 250, y: hub.y + 64 + i * SKILL_DY })
      pos.set(m.id, p)
      nodes.push({ id: m.id, type: 'mcp', position: p, data: { mcp: m } })
      edge(USER_HUB_ID, m.id, needsUser(m.status === 'needs-auth' ? 'input' : 'idle'), true)
    })
  }

  // Projects with their own skills and MCP servers underneath.
  for (const project of Object.values(s.projects)) {
    const p = at(project.id, project.position)
    pos.set(project.id, p)
    const mine = sessions.filter((x) => x.projectId === project.id)
    const myLoops = loops.filter((l) => l.projectId === project.id)
    const loopStatuses = myLoops.map((l) => loopStatus(l, s.sessions)).filter((st) => st !== 'idle')
    const status = rollup([...mine.map((x) => x.status), ...loopStatuses])
    const busy = mine.some((x) => x.status !== 'finished') || myLoops.some((l) => ['optimizing', 'running', 'waiting', 'paused'].includes(l.state))
    nodes.push({
      id: project.id,
      type: 'project',
      position: p,
      data: { project, status, stats: s.git[project.id], busy }
    })
    const extras = [...s.skills.filter((k) => k.projectId === project.id), ...s.mcp.filter((m) => m.projectId === project.id)]
    extras.forEach((x, i) => {
      const xp = at(x.id, { x: p.x + 44, y: p.y + 104 + i * SKILL_DY })
      pos.set(x.id, xp)
      const isMcp = x.id.startsWith('mcp:')
      nodes.push(isMcp ? { id: x.id, type: 'mcp', position: xp, data: { mcp: x } } : { id: x.id, type: 'skill', position: xp, data: { skill: x } })
      edge(project.id, x.id, false, true)
    })
    // Loops sit below the project, under its own skills and MCP servers, each with room for the
    // sessions it currently shows (its running step, or prompts being improved).
    let loopY = p.y + 112 + extras.length * SKILL_DY
    myLoops.forEach((l) => {
      const shown = sessions.filter((x) => x.anchorId === l.id).length
      const lp = at(l.id, l.position ?? { x: p.x + 44, y: loopY })
      loopY += LOOP_DY + shown * LOOP_SESSION_DY
      pos.set(l.id, lp)
      const st = loopStatus(l, s.sessions)
      nodes.push({ id: l.id, type: 'loop', position: lp, data: { loop: l, status: st } })
      edge(project.id, l.id, needsUser(st), st === 'finished' || st === 'idle')
    })
  }

  // Sessions hang off their anchor; config sessions on user skills sit left of the skill grid.
  const perAnchor = new Map<string, number>()
  const anchorCount = new Map<string, number>()
  for (const x of sessions) anchorCount.set(x.anchorId, (anchorCount.get(x.anchorId) ?? 0) + 1)
  for (const x of sessions) {
    let anchor = pos.has(x.anchorId) ? x.anchorId : x.projectId && pos.has(x.projectId) ? x.projectId : USER_HUB_ID
    const a = pos.get(anchor)!
    const i = perAnchor.get(x.anchorId) ?? 0
    perAnchor.set(x.anchorId, i + 1)
    const n = anchorCount.get(x.anchorId) ?? 1
    let fallback: Point
    if (anchor === x.projectId || (anchor === USER_HUB_ID && x.anchorId === USER_HUB_ID)) {
      fallback = { x: a.x + SESSION_DX, y: a.y + 4 + (i - (n - 1) / 2) * SESSION_DY }
    } else if (s.skills.some((k) => k.id === anchor && !k.projectId)) {
      fallback = { x: skillsLeftEdge - 330, y: a.y + i * 44 }
    } else if (anchor === USER_HUB_ID) {
      fallback = { x: a.x, y: a.y - 90 - i * 50 }
    } else if (loopIds.has(anchor)) {
      fallback = { x: a.x + LOOP_SESSION_DX, y: a.y + 52 + i * LOOP_SESSION_DY }
    } else {
      fallback = { x: a.x + 260, y: a.y + i * 44 }
    }
    const sp = at(x.id, x.position ?? fallback)
    pos.set(x.id, sp)
    // Only a handed-off optimize step fades away; a failed or refused one stays so it can be opened.
    const leaving = x.kind === 'optimize' && !!x.handedOff
    nodes.push({ id: x.id, type: 'session', position: sp, data: { session: x, leaving } })
    edge(anchor, x.id, needsUser(x.status), x.status === 'finished')
  }

  // Agents fan out to the right of their session.
  const agentsBySession = new Map<string, State['agents'][string][]>()
  for (const ag of Object.values(s.agents)) agentsBySession.set(ag.sessionId, [...(agentsBySession.get(ag.sessionId) ?? []), ag])
  for (const [sessionId, list] of agentsBySession) {
    const sp = pos.get(sessionId)
    if (!sp) continue
    list.forEach((ag, j) => {
      const p = at(ag.id, { x: sp.x + AGENT_DX, y: sp.y + 4 + (j - (list.length - 1) / 2) * AGENT_DY })
      pos.set(ag.id, p)
      nodes.push({ id: ag.id, type: 'agent', position: p, data: { agent: ag } })
      edge(sessionId, ag.id, needsUser(ag.status), ag.status === 'finished')
    })
  }

  // Leave from the side that faces the child, so edges never cut back across their own node.
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (!a || !b) continue
    // Children stacked under their parent (MCP under the hub; skills, MCP and loops under a project) hang from its bottom.
    const below = b.y > a.y + 40 && b.x >= a.x - 20 && b.x < a.x + 160
    if ((e.source === USER_HUB_ID && s.mcp.some((m) => m.id === e.target)) || ((s.projects[e.source] || s.loops[e.source]) && below)) {
      e.sourceHandle = 'sb'
      e.targetHandle = 'tl'
    } else if (b.x < a.x - 40) {
      e.sourceHandle = 'sl'
      e.targetHandle = 'tr'
    } else {
      e.sourceHandle = 'sr'
      e.targetHandle = 'tl'
    }
  }

  return { nodes, edges }
}

const PERSISTED = (id: string, s: State) => id === USER_HUB_ID || !!s.projects[id] || !!s.sessions[id] || !!s.loops[id]

export function Graph() {
  const state = useStore()
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const moved = useRef<Record<string, Point>>({})
  const [tick, setTick] = useState(0)
  const raf = useRef(0)
  const { fitView, getNodes, getViewport } = useReactFlow()

  // Fitting before React Flow has measured newly added nodes frames only part of the graph, so wait for sizes.
  const fitAll = useCallback(() => {
    let frames = 0
    const attempt = () => {
      const pending = getNodes().some((n) => !n.measured?.width)
      if (pending && frames++ < 60) return void requestAnimationFrame(attempt)
      void fitView({ padding: 0.12, maxZoom: 1, duration: 350 })
    }
    requestAnimationFrame(attempt)
  }, [fitView, getNodes])

  // Refit when the graph's structure changes (projects added/removed, config arrives, hub toggled), not on every status change.
  const structure = `${Object.keys(state.projects).sort().join(',')}|${state.skills.length > 0}|${state.mcp.length > 0}|${state.hubOpen}`
  useEffect(() => {
    const t = setTimeout(fitAll, 120)
    return () => clearTimeout(t)
  }, [structure, fitAll])

  // When sessions or agents appear, zoom out only if one landed outside the window.
  const liveKey = `${Object.keys(state.sessions).sort().join(',')}|${Object.keys(state.agents).sort().join(',')}|${Object.keys(state.loops).sort().join(',')}`
  useEffect(() => {
    const t = setTimeout(() => {
      const { x, y, zoom } = getViewport()
      const off = getNodes().some((n) => {
        const left = n.position.x * zoom + x
        const top = n.position.y * zoom + y
        const right = left + (n.measured?.width ?? 0) * zoom
        const bottom = top + (n.measured?.height ?? 0) * zoom
        return left < 0 || top < 36 || right > window.innerWidth || bottom > window.innerHeight
      })
      if (off) fitAll()
    }, 250)
    return () => clearTimeout(t)
  }, [liveKey, fitAll, getNodes, getViewport])

  useEffect(() => {
    const next = layout(state, moved.current)
    setEdges(next.edges)
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      return next.nodes.map((n) => {
        const old = prevById.get(n.id)
        return old ? { ...old, ...n, measured: old.measured, dragging: old.dragging } : n
      })
    })
    // Recompute on any state change or drag movement.
  }, [state.projects, state.sessions, state.agents, state.skills, state.mcp, state.git, state.hubPosition, state.hubOpen, state.loops, tick])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let movedAny = false
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        moved.current[c.id] = c.position
        movedAny = true
      }
    }
    setNodes((nds) => applyNodeChanges(changes, nds))
    if (movedAny) {
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => setTick((t) => t + 1))
    }
  }, [])

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    if (PERSISTED(node.id, useStore.getState())) void api.moveNode(node.id, node.position)
  }, [])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const s = useStore.getState()
    switch (node.type) {
      case 'session':
        return s.openPanel('session', node.id)
      case 'agent':
        return s.openPanel('agent', node.id)
      case 'loop':
        return s.openPanel('loop', node.id)
      case 'hub':
        return s.setHubOpen(!s.hubOpen)
      case 'skill':
        return s.openPanel('skill', node.id)
      case 'mcp':
        return s.openPanel('mcp', node.id)
    }
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    const s = useStore.getState()
    if (node.type === 'session') return s.openPanel('session', node.id)
    if (node.type === 'loop') return s.openPanel('loop', node.id)
    if (node.type !== 'project' && node.type !== 'skill' && node.type !== 'mcp') return
    const el = (event.target as Element).closest('.react-flow__node')
    const rect = el?.getBoundingClientRect()
    s.setComposer({ kind: node.type, targetId: node.id, left: rect?.left ?? event.clientX, right: rect?.right ?? event.clientX, top: rect?.top ?? event.clientY })
  }, [])

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={(e) => e.preventDefault()}
        onPaneClick={() => useStore.getState().setComposer(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        // No canvas keyboard shortcuts: they listen on the whole document and would swallow keys typed in panels.
        deleteKeyCode={null}
        panActivationKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomActivationKeyCode={null}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  )
}
