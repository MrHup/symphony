import { applyNodeChanges, ReactFlow, SelectionMode, useReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCAL_MACHINE_NODE, machineNodeId, splitMachine } from '@shared/remote'
import { USER_HUB_ID, type NodeStatus, type Point } from '@shared/types'
import { api, hubIdFor, inWorkspace, lockReason, loopStatus, machineUp, needsUser, rollup, useStore } from '../store'
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
const ARRANGE_DX = 90
const ARRANGE_DY = 18
const ARRANGE_TREE_GAP = 60

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
  // Only the selected workspace's projects, loops and notes are drawn; machines and hubs show in every workspace.
  const loops = Object.values(s.loops)
    .filter((l) => inWorkspace(s, l.id))
    .sort((a, b) => a.createdAt - b.createdAt)
  const loopIds = new Set(loops.map((l) => l.id))
  // Everything on an offline machine fades and loses the signal color: it cannot be answered until the machine is back.
  const remote = Object.values(s.machines)
  const offlineIds = new Set(remote.filter((m) => !machineUp(m)).map((m) => m.id))
  const off = (machineId?: string) => !!machineId && offlineIds.has(machineId)
  const shown = (status: NodeStatus, offline: boolean): NodeStatus => (offline ? (status === 'finished' ? 'finished' : 'idle') : status)
  const edge = (source: string, target: string, signal: boolean, faded = false, offline = false) =>
    edges.push({ id: `${source}->${target}`, source, target, className: offline ? 'edge-offline' : signal ? 'edge-signal' : faded ? 'edge-faded' : undefined, selectable: false, focusable: false })
  // A machine's color tints the glyphs of everything on it (the signal shapes keep their color).
  const tint = (machineId?: string) => {
    const color = s.machineColors[machineId ?? 'local']
    return color ? `accent-${color}` : undefined
  }

  // One root per machine: this one, then each remote machine, with its ~/.claude hub under it.
  const hubIds = new Set<string>()
  const machineIds = new Set<string>()
  const skillsLeftEdge = new Map<string, number>()
  const roots: { machineId?: string; hubPos: Point }[] = [{ hubPos: s.hubPosition }]
  const lp = at(LOCAL_MACHINE_NODE, s.machinePosition)
  pos.set(LOCAL_MACHINE_NODE, lp)
  machineIds.add(LOCAL_MACHINE_NODE)
  nodes.push({ id: LOCAL_MACHINE_NODE, type: 'machine', position: lp, className: tint(), data: { local: true } })
  for (const m of remote) {
    const id = machineNodeId(m.id)
    const mp = at(id, m.position)
    pos.set(id, mp)
    machineIds.add(id)
    nodes.push({ id, type: 'machine', position: mp, className: tint(m.id), data: { machine: m } })
    // A machine that only asks to pair has no hub yet.
    if (m.status !== 'pairing' || Object.values(s.projects).some((p) => p.machineId === m.id)) roots.push({ machineId: m.id, hubPos: m.hubPosition })
  }

  // Hubs with user-level skills and MCP servers.
  for (const root of roots) {
    const hubId = hubIdFor(root.machineId)
    const offline = off(root.machineId)
    const hub = at(hubId, root.hubPos)
    pos.set(hubId, hub)
    hubIds.add(hubId)
    const open = !!s.skillsShown[hubId]
    const userSkills = s.skills.filter((k) => !k.projectId && k.machineId === root.machineId)
    const userMcp = s.mcp.filter((m) => !m.projectId && m.machineId === root.machineId)
    nodes.push({ id: hubId, type: 'hub', position: hub, className: tint(root.machineId), data: { open, skills: userSkills.length, mcp: userMcp.length, machineId: root.machineId, offline } })
    edge(root.machineId ? machineNodeId(root.machineId) : LOCAL_MACHINE_NODE, hubId, false, true, offline)
    const rows = Math.min(SKILL_ROWS, Math.max(1, userSkills.length))
    const cols = Math.ceil(userSkills.length / SKILL_ROWS)
    skillsLeftEdge.set(hubId, hub.x - 240 - (cols - 1) * SKILL_COL_W)
    // MCP servers always show: one may need you to authenticate.
    if (open) {
      userSkills.forEach((k, i) => {
        const c = Math.floor(i / SKILL_ROWS)
        const r = i % SKILL_ROWS
        const p = at(k.id, { x: hub.x - 240 - c * SKILL_COL_W, y: hub.y + 6 + (r - (rows - 1) / 2) * SKILL_DY })
        pos.set(k.id, p)
        nodes.push({ id: k.id, type: 'skill', position: p, className: tint(root.machineId), data: { skill: k, offline } })
        edge(hubId, k.id, false, true, offline)
      })
    }
    userMcp.forEach((m, i) => {
      const p = at(m.id, { x: hub.x + 250, y: hub.y + 64 + i * SKILL_DY })
      pos.set(m.id, p)
      nodes.push({ id: m.id, type: 'mcp', position: p, className: tint(root.machineId), data: { mcp: m, offline } })
      edge(hubId, m.id, needsUser(m.status === 'needs-auth' ? 'input' : 'idle'), true, offline)
    })
  }

  // Projects with their own skills and MCP servers underneath.
  const shownProjects = new Set<string>()
  for (const project of Object.values(s.projects)) {
    if (!inWorkspace(s, project.id)) continue
    shownProjects.add(project.id)
    const offline = off(project.machineId)
    const p = at(project.id, project.position)
    pos.set(project.id, p)
    const mine = sessions.filter((x) => x.projectId === project.id)
    const status = shown(rollup(mine.map((x) => x.status)), offline)
    const busy = mine.some((x) => x.status !== 'finished')
    const cls = tint(project.machineId)
    const extras = [...s.skills.filter((k) => k.projectId === project.id), ...s.mcp.filter((m) => m.projectId === project.id)]
    // A collapsed project folds away its sessions, skills and MCP servers; its glyph still rolls up their status.
    const collapsed = !!s.collapsed[project.id] && mine.length + extras.length > 0
    nodes.push({
      id: project.id,
      type: 'project',
      position: p,
      className: cls,
      data: { project, status, stats: s.git[project.id], busy, offline, machine: project.machineId ? s.machines[project.machineId] : undefined, folded: collapsed ? mine.length + extras.length : 0 }
    })
    edge(project.machineId ? machineNodeId(project.machineId) : LOCAL_MACHINE_NODE, project.id, false, true, offline)
    if (collapsed) continue
    extras.forEach((x, i) => {
      const xp = at(x.id, { x: p.x + 44, y: p.y + 104 + i * SKILL_DY })
      pos.set(x.id, xp)
      const isMcp = 'tools' in x
      nodes.push(isMcp ? { id: x.id, type: 'mcp', position: xp, className: cls, data: { mcp: x, offline } } : { id: x.id, type: 'skill', position: xp, className: cls, data: { skill: x, offline } })
      edge(project.id, x.id, false, true, offline)
    })
  }

  // Loops belong to a machine: they stack upward from its node, each with room below it for the
  // sessions it currently shows (its running step, or prompts being improved).
  const loopTop = new Map<string, number>()
  for (const l of loops) {
    const machine = l.machineId ? machineNodeId(l.machineId) : LOCAL_MACHINE_NODE
    const m = pos.get(machine)
    if (!m) continue
    const offline = off(l.machineId)
    const count = sessions.filter((x) => x.anchorId === l.id).length
    const top = (loopTop.get(machine) ?? m.y - 20) - LOOP_DY - count * LOOP_SESSION_DY
    loopTop.set(machine, top)
    const lp = at(l.id, l.position ?? { x: m.x + 44, y: top })
    pos.set(l.id, lp)
    const st = shown(loopStatus(l, s.sessions), offline)
    nodes.push({ id: l.id, type: 'loop', position: lp, className: tint(l.machineId), data: { loop: l, status: st, offline } })
    edge(machine, l.id, needsUser(st), st === 'finished' || st === 'idle', offline)
  }

  // Sessions hang off their anchor; config sessions on user skills sit left of the skill grid.
  const perAnchor = new Map<string, number>()
  const anchorCount = new Map<string, number>()
  for (const x of sessions) anchorCount.set(x.anchorId, (anchorCount.get(x.anchorId) ?? 0) + 1)
  for (const x of sessions) {
    if (x.projectId && s.projects[x.projectId] && (!shownProjects.has(x.projectId) || s.collapsed[x.projectId])) continue
    if (s.loops[x.anchorId] && !loopIds.has(x.anchorId)) continue
    const offline = off(x.machineId)
    const hubId = hubIdFor(x.machineId)
    const anchor = pos.has(x.anchorId) ? x.anchorId : x.projectId && pos.has(x.projectId) ? x.projectId : hubId
    const a = pos.get(anchor)
    if (!a) continue
    const i = perAnchor.get(x.anchorId) ?? 0
    perAnchor.set(x.anchorId, i + 1)
    const n = anchorCount.get(x.anchorId) ?? 1
    const userSkill = s.skills.find((k) => k.id === anchor && !k.projectId)
    let fallback: Point
    if (anchor === x.projectId || (hubIds.has(anchor) && x.anchorId === anchor)) {
      fallback = { x: a.x + SESSION_DX, y: a.y + 4 + (i - (n - 1) / 2) * SESSION_DY }
    } else if (userSkill) {
      fallback = { x: (skillsLeftEdge.get(hubIdFor(userSkill.machineId)) ?? a.x) - 330, y: a.y + i * 44 }
    } else if (hubIds.has(anchor)) {
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
    const session = offline ? { ...x, status: shown(x.status, true) } : x
    nodes.push({ id: x.id, type: 'session', position: sp, className: tint(x.machineId), data: { session, leaving, offline } })
    edge(anchor, x.id, needsUser(session.status), session.status === 'finished', offline)
  }

  // Agents fan out to the right of their session.
  const agentsBySession = new Map<string, State['agents'][string][]>()
  for (const ag of Object.values(s.agents)) agentsBySession.set(ag.sessionId, [...(agentsBySession.get(ag.sessionId) ?? []), ag])
  for (const [sessionId, list] of agentsBySession) {
    const sp = pos.get(sessionId)
    if (!sp) continue
    const offline = off(s.sessions[sessionId]?.machineId)
    const cls = tint(s.sessions[sessionId]?.machineId)
    list.forEach((ag, j) => {
      const p = at(ag.id, { x: sp.x + AGENT_DX, y: sp.y + 4 + (j - (list.length - 1) / 2) * AGENT_DY })
      pos.set(ag.id, p)
      const agent = offline ? { ...ag, status: shown(ag.status, true) } : ag
      nodes.push({ id: ag.id, type: 'agent', position: p, className: cls, data: { agent, offline } })
      edge(sessionId, ag.id, needsUser(agent.status), agent.status === 'finished', offline)
    })
  }

  // Sticky notes, drawn over everything else.
  for (const n of Object.values(s.notes)) if (inWorkspace(s, n.id)) nodes.push({ id: n.id, type: 'note', position: at(n.id, n.position), data: { note: n } })

  // Leave from the side that faces the child, so edges never cut back across their own node.
  const mcpIds = new Set(s.mcp.map((m) => m.id))
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (!a || !b) continue
    // Children stacked under their parent (MCP under a hub; a hub under its machine; skills and MCP under a project) hang from its bottom; loops stacked over their machine, from its top.
    const below = b.y > a.y + 40 && b.x >= a.x - 20 && b.x < a.x + 160
    const above = b.y < a.y - 40 && b.x >= a.x - 20 && b.x < a.x + 160
    if ((hubIds.has(e.source) && mcpIds.has(e.target) && b.y > a.y + 40) || ((s.projects[e.source] || s.loops[e.source] || machineIds.has(e.source)) && below)) {
      e.sourceHandle = 'sb'
      e.targetHandle = 'tl'
    } else if (machineIds.has(e.source) && above) {
      e.sourceHandle = 'st'
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

/**
 * A tidy left-to-right tree per machine: each depth in its own column, each subtree in its own band
 * with its parent centered on it, so neither nodes nor edges cross. Sticky notes keep their place.
 */
function arrange(nodes: Node[], edges: Edge[]): Record<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || hasParent.has(e.target)) continue
    children.set(e.source, [...(children.get(e.source) ?? []), e.target])
    hasParent.add(e.target)
  }
  const width = (id: string) => byId.get(id)?.measured?.width ?? 0
  const height = (id: string) => byId.get(id)?.measured?.height ?? 0
  const roots = nodes.filter((n) => n.type !== 'note' && !hasParent.has(n.id))
  const positions: Record<string, Point> = {}
  const origin = roots[0]?.position ?? { x: 0, y: 0 }
  let top = origin.y

  for (const root of roots) {
    // First pass: the height of every subtree and the width of every column.
    const band = new Map<string, number>()
    const span = new Map<string, number>()
    const columns: number[] = []
    const measure = (id: string, depth: number): number => {
      columns[depth] = Math.max(columns[depth] ?? 0, width(id))
      const kids = children.get(id) ?? []
      const total = kids.reduce((sum, k) => sum + measure(k, depth + 1), 0) + Math.max(0, kids.length - 1) * ARRANGE_DY
      span.set(id, total)
      band.set(id, Math.max(height(id), total))
      return band.get(id)!
    }
    measure(root.id, 0)
    const columnX = columns.map((_, d) => origin.x + columns.slice(0, d).reduce((sum, w) => sum + w + ARRANGE_DX, 0))

    // Second pass: place each node in the middle of its band, its children stacked beside it.
    const place = (id: string, depth: number, y: number) => {
      const h = band.get(id)!
      positions[id] = { x: columnX[depth], y: y + (h - height(id)) / 2 }
      let next = y + (h - span.get(id)!) / 2
      for (const k of children.get(id) ?? []) {
        place(k, depth + 1, next)
        next += band.get(k)! + ARRANGE_DY
      }
    }
    place(root.id, 0, top)
    top += band.get(root.id)! + ARRANGE_TREE_GAP
  }
  return positions
}

/**
 * Whether Shift is held. React Flow's own selection key would listen through its key handler,
 * which can cancel keys typed in panels; this only watches.
 */
function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setHeld(e.shiftKey)
    const release = () => setHeld(false)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', release)
    }
  }, [])
  return held
}

const PERSISTED = (id: string, s: State) =>
  id === USER_HUB_ID || id.startsWith('machine:') || splitMachine(id)?.id === USER_HUB_ID || !!s.projects[id] || !!s.sessions[id] || !!s.loops[id] || !!s.notes[id]

export function Graph() {
  const state = useStore()
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const moved = useRef<Record<string, Point>>({})
  const [tick, setTick] = useState(0)
  const raf = useRef(0)
  const { fitView, getNodes, getEdges, getViewport, screenToFlowPosition } = useReactFlow()
  const boxSelect = useShiftHeld()

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

  // The dock's Arrange button: lay everything out again, keep it, and frame it.
  const arranged = useRef(0)
  useEffect(() => {
    if (state.arrangeRequest === arranged.current) return
    arranged.current = state.arrangeRequest
    const s = useStore.getState()
    for (const [id, p] of Object.entries(arrange(getNodes(), getEdges()))) {
      moved.current[id] = p
      if (PERSISTED(id, s)) void api.moveNode(id, p)
    }
    setTick((t) => t + 1)
    const t = setTimeout(fitAll, 120)
    return () => clearTimeout(t)
  }, [state.arrangeRequest, getNodes, getEdges, fitAll])

  // Refit when the graph's structure changes (projects added/removed, config arrives, hub toggled), not on every status change.
  const structure = `${Object.keys(state.projects).sort().join(',')}|${state.skills.length > 0}|${state.mcp.length > 0}|${JSON.stringify(state.skillsShown)}|${Object.values(state.machines).map((m) => `${m.id}:${m.status === 'pairing'}`).sort().join(',')}|${state.workspaces.active}`
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
  }, [state.projects, state.sessions, state.agents, state.skills, state.mcp, state.git, state.hubPosition, state.skillsShown, state.loops, state.machines, state.machinePosition, state.machineColors, state.notes, state.workspaces, state.collapsed, tick])

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

  // Selected nodes move together, so each of them is saved.
  const onNodeDragStop = useCallback((_: unknown, _node: Node, dragged: Node[]) => {
    const s = useStore.getState()
    for (const n of dragged) if (PERSISTED(n.id, s)) void api.moveNode(n.id, n.position)
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
        return s.toggleHub(node.id)
      case 'project':
        return s.toggleCollapsed(node.id)
      case 'skill':
        return s.openPanel('skill', node.id)
      case 'mcp':
        return s.openPanel('mcp', node.id)
      case 'machine': {
        const m = s.machines[node.id.slice('machine:'.length)]
        if (m?.status === 'pairing') return s.openPanel('pairing', m.id)
        return
      }
    }
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    const s = useStore.getState()
    if (node.type === 'session') return s.openPanel('session', node.id)
    if (node.type === 'loop') return s.openPanel('loop', node.id)
    const el = (event.target as Element).closest('.react-flow__node')
    const rect = el?.getBoundingClientRect()
    const at = { left: rect?.left ?? event.clientX, right: rect?.right ?? event.clientX, top: rect?.top ?? event.clientY }
    // A machine's color is kept here, so it can be changed while that machine is offline.
    if (node.type === 'machine') {
      const machineId = node.id.slice('machine:'.length)
      if (s.control || s.machines[machineId]?.status === 'pairing') return
      return s.setColorMenu({ machineId, ...at })
    }
    if (node.type !== 'project' && node.type !== 'skill' && node.type !== 'mcp') return
    // No prompt bubble while the window is read-only or the node's machine is offline.
    const machineId = s.projects[node.id]?.machineId ?? [...s.skills, ...s.mcp].find((x) => x.id === node.id)?.machineId
    if (lockReason(s, machineId)) return
    s.setComposer({ kind: node.type, targetId: node.id, ...at })
  }, [])

  // Right-clicking empty canvas leaves a sticky note there.
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      const s = useStore.getState()
      s.setComposer(null)
      if (lockReason(s)) return
      void api.noteCreate(screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [screenToFlowPosition]
  )

  // React Flow clears a selection only while elements are selectable, which here is only while Shift is held.
  const onPaneClick = useCallback(() => {
    useStore.getState().setComposer(null)
    setNodes((nds) => (nds.some((n) => n.selected) ? nds.map((n) => (n.selected ? { ...n, selected: false } : n)) : nds))
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
        nodesDraggable={!state.control}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={onPaneClick}
        nodesConnectable={false}
        edgesFocusable={false}
        // Shift+drag on the canvas selects; dragging a selected node moves the whole selection.
        elementsSelectable={boxSelect}
        selectionOnDrag={boxSelect}
        panOnDrag={!boxSelect}
        selectionMode={SelectionMode.Partial}
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
