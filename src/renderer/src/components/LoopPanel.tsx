import { applyNodeChanges, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffortLevel, LoopDraft, LoopEdge, LoopFile, LoopFolder, LoopFolderRole, LoopInfo, LoopMove, LoopStep, LoopStepKind, Point } from '@shared/types'
import { readImage } from '../images'
import { api, clock, loopStatus, machineConfig, useLock, useStore, type Panel } from '../store'
import { Attachments } from './Attachments'
import { sizeText, Viewable } from './Files'
import { useDictation } from '../speech/dictation'
import { DictationOverlay, DictationStatus, MicButton } from './Dictate'
import { cleanError, EffortSelect, ModelSelect } from './Composer'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'
import { IconClose, IconFolder, IconTrash } from './icons'
import { Markdown } from './Markdown'
import { useModelLabel } from './nodes'

const DEFAULT_MAX_RUNS = 12
const STATE_LABEL: Record<LoopInfo['state'], string> = {
  draft: 'draft',
  optimizing: 'improving prompts',
  running: 'running',
  waiting: 'waiting for you',
  paused: 'paused',
  done: 'done',
  stopped: 'stopped'
}
const ACTIVE: LoopInfo['state'][] = ['optimizing', 'running', 'waiting', 'paused']
const ROLES: LoopFolderRole[] = ['session', 'input', 'output']

type Graph = Pick<LoopDraft, 'steps' | 'folders' | 'links' | 'edges' | 'start'>
/** What is selected in the loop graph; a link's id is `stepId:role`. */
type Sel = { kind: 'step' | 'folder' | 'edge' | 'link'; id: string } | null

const uid = () => crypto.randomUUID()
const swap = <T extends { id: string }>(list: T[], id: string, p: Partial<T>) => list.map((x) => (x.id === id ? { ...x, ...p } : x))
const freeName = (base: string, taken: string[]) => {
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`
  return name
}
const titleOf = (g: Graph, id: string | null) => {
  const s = g.steps.find((x) => x.id === id)
  return s?.title || (s?.kind === 'human' ? 'Human review' : 'Agent step')
}

/** A new step, using the default model and effort of the machine the loop belongs to. */
function newStep(kind: LoopStepKind, machineId: string | undefined, position: Point): LoopStep {
  const { defaultModel: model, efforts } = machineConfig(useStore.getState(), machineId)
  return { id: uid(), kind, title: '', prompt: '', position, ...(kind === 'agent' ? { model, effort: efforts[model], images: [] } : {}) }
}

/** A new loop: an agent step works in a folder you pick, reads one temporary folder and writes another, which you review. */
function starter(machineId?: string): LoopDraft {
  const agent = newStep('agent', machineId, { x: 0, y: 0 })
  const review = newStep('human', machineId, { x: 340, y: 0 })
  const folder = (name: string, x: number, path?: string): LoopFolder => ({ id: uid(), name, path, position: { x, y: 190 } })
  const project = folder('project', -60, '')
  const input = folder('input', 120)
  const output = folder('output', 300)
  return {
    name: '',
    steps: [agent, review],
    folders: [project, input, output],
    links: [
      { stepId: agent.id, folderId: project.id, role: 'session' },
      { stepId: agent.id, folderId: input.id, role: 'input' },
      { stepId: agent.id, folderId: output.id, role: 'output' },
      { stepId: review.id, folderId: output.id, role: 'input' }
    ],
    edges: [{ id: uid(), from: agent.id, to: review.id }],
    start: agent.id,
    maxRuns: DEFAULT_MAX_RUNS,
    optimize: true
  }
}

/** The draft without a step or folder (a folder takes its subfolders along) and whatever connected to it. */
function without(d: LoopDraft, id: string): LoopDraft {
  const gone = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of d.folders) {
      if (!f.parentId || !gone.has(f.parentId) || gone.has(f.id)) continue
      gone.add(f.id)
      grew = true
    }
  }
  const steps = d.steps.filter((s) => !gone.has(s.id))
  return {
    ...d,
    steps,
    folders: d.folders.filter((f) => !gone.has(f.id)),
    links: d.links.filter((k) => !gone.has(k.stepId) && !gone.has(k.folderId)),
    edges: d.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    start: d.start && gone.has(d.start) ? (steps[0]?.id ?? null) : d.start
  }
}

export function LoopPanel({ panel }: { panel: Panel }) {
  const isNew = panel.targetId.startsWith('new:')
  const loop = useStore((s) => (isNew ? undefined : s.loops[panel.targetId]))
  const sessions = useStore((s) => s.sessions)
  const where = panel.targetId.slice(4).split('#')[0]
  const machineId = isNew ? (where === 'local' ? undefined : where) : loop?.machineId
  const machineName = useStore((s) => (machineId ? s.machines[machineId]?.name : 'This PC'))
  const lock = useLock(machineId)
  if ((!isNew && !loop) || !machineName) return null
  const status = loop ? loopStatus(loop, sessions) : 'idle'
  const active = !!loop && ACTIVE.includes(loop.state)

  return (
    <FloatingPanel
      panel={panel}
      machineId={machineId}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <Glyph status={status} size={12} variant="loop" />
          {loop?.name ?? 'New loop'}
        </span>
      }
      meta={`${machineName}${loop ? ` · ${STATE_LABEL[loop.state]}${loop.runs ? ` · ${loop.runs} runs` : ''}` : ''}`}
      actions={
        loop &&
        (active ? (
          <button className="btn ghost" disabled={!!lock} onClick={() => void api.loopStop(loop.id)}>
            Stop loop
          </button>
        ) : (
          <button className="icon-btn" title="Delete loop and its temporary folders" disabled={!!lock} onClick={() => void api.loopDelete(loop.id)}>
            <IconTrash />
          </button>
        ))
      }
    >
      <div className="loop-body">
        {/* Read-only window or offline machine: the loop can be read but not edited or routed. */}
        <fieldset className="lock" disabled={!!lock} title={lock ?? undefined}>
          {active && loop ? (
            <LoopRun loop={loop} />
          ) : (
            <LoopEditor
              key={loop?.id ?? panel.targetId}
              machineId={machineId}
              loop={loop}
              onCreated={(created) => useStore.getState().updatePanel(panel.id, { targetId: created.id })}
            />
          )}
        </fieldset>
        {loop && loop.history.length > 0 && <History loop={loop} />}
      </div>
    </FloatingPanel>
  )
}

// ---------- the loop's graph ----------

type StepNodeType = Node<{ step: LoopStep; start: boolean; current: boolean; editable: boolean }, 'step'>
type FolderNodeType = Node<{ folder: LoopFolder; temporary: boolean; where: string; path?: string; editable: boolean }, 'folder'>

/** A step: drag from its right edge to the next step, and from its labelled handles to its folders. */
function StepNode({ data }: NodeProps<StepNodeType>) {
  const { step, start, current, editable } = data
  const human = step.kind === 'human'
  return (
    <div className={`loop-step${human ? ' is-human' : ''}${current ? ' is-current' : ''}`}>
      <Handle id="prev" type="target" position={Position.Left} isConnectable={editable} />
      <div className="loop-step-head">
        <span className={`pip ${step.kind}${current ? ' is-current' : ''}`} />
        <span className="loop-step-title">{step.title || (human ? 'Human review' : 'Agent step')}</span>
        {start && <span className="loop-step-start">start</span>}
      </div>
      <div className="loop-step-roles">
        {(human ? (['input'] as const) : ROLES).map((r) => (
          <span key={r} className={`loop-role is-${r}`}>
            {r}
            <Handle id={r} type="source" position={Position.Bottom} isConnectable={editable} />
          </span>
        ))}
      </div>
      <Handle id="next" type="source" position={Position.Right} isConnectable={editable} />
    </div>
  )
}

/** A folder: dashed while temporary. */
function FolderNode({ data }: NodeProps<FolderNodeType>) {
  const { folder, temporary, where, path, editable } = data
  return (
    <div className={`loop-folder${temporary ? ' is-temp' : ''}`} title={path || where}>
      <Handle id="folder" type="target" position={Position.Top} isConnectable={editable} />
      <IconFolder />
      <div className="node-text">
        <span className="loop-folder-name">{folder.name}</span>
        <span className="loop-folder-where">{where.length > 21 ? `…${where.slice(-20)}` : where}</span>
      </div>
      <Handle id="sub" type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

const loopNodeTypes = { step: StepNode, folder: FolderNode }

/** Brings a step or folder just added into view. */
function FitOnAdd({ count }: { count: number }) {
  const { fitView } = useReactFlow()
  const seen = useRef(count)
  useEffect(() => {
    if (count > seen.current) setTimeout(() => void fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 50)
    seen.current = count
  }, [count, fitView])
  return null
}

const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, color, width: 14, height: 14 })
const clip = (text: string) => (text.length > 28 ? `${text.slice(0, 27)}…` : text)
const validConnection = (c: Connection | Edge) => c.source !== c.target && (c.sourceHandle === 'next' ? c.targetHandle === 'prev' : c.targetHandle === 'folder')

/**
 * Steps, folders and how they connect. Step-to-step edges are solid with an arrow; a step's
 * folders hang off its labelled handles: input dashed into the step, output solid into the
 * folder, session dotted. Editable when `onConnect` is given.
 */
function LoopGraph({
  graph,
  current,
  sel,
  onSelect,
  onMove,
  onConnect
}: {
  graph: Graph
  current?: string | null
  sel: Sel
  onSelect: (s: Sel) => void
  onMove?: (id: string, position: Point) => void
  onConnect?: (c: Connection) => void
}) {
  const editable = !!onConnect
  const derived = useMemo<Node[]>(() => {
    const byId = new Map(graph.folders.map((f) => [f.id, f]))
    const root = (f: LoopFolder): LoopFolder => (f.parentId && byId.has(f.parentId) ? root(byId.get(f.parentId)!) : f)
    const cls = (id: string) => (sel?.id === id ? 'is-selected' : undefined)
    return [
      ...graph.steps.map((s) => ({ id: s.id, type: 'step', position: s.position, className: cls(s.id), data: { step: s, start: graph.start === s.id, current: current === s.id, editable } })),
      ...graph.folders.map((f) => ({
        id: f.id,
        type: 'folder',
        position: f.position,
        className: cls(f.id),
        data: {
          folder: f,
          editable,
          temporary: root(f).path === undefined,
          where: f.parentId ? `in ${byId.get(f.parentId)?.name ?? ''}` : f.path === undefined ? 'temporary' : f.path || 'pick a folder',
          path: f.path
        }
      }))
    ]
  }, [graph.steps, graph.folders, graph.start, current, sel, editable])
  // Kept in state so React Flow's measured sizes survive each change to the graph.
  const [nodes, setNodes] = useState<Node[]>(derived)
  useEffect(
    () =>
      setNodes((prev) => {
        const old = new Map(prev.map((n) => [n.id, n]))
        return derived.map((n) => {
          const o = old.get(n.id)
          return o ? { ...o, ...n, measured: o.measured } : n
        })
      }),
    [derived]
  )
  const edges = useMemo<Edge[]>(() => {
    const picked = (id: string) => (sel?.id === id ? ' is-selected' : '')
    return [
      ...graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: 'next',
        targetHandle: 'prev',
        className: `loop-edge is-step${picked(e.id)}`,
        markerEnd: arrow('var(--bone)'),
        label: e.prompt ? clip(e.prompt) : undefined,
        data: { sel: { kind: 'edge', id: e.id } }
      })),
      ...graph.links.map((k) => {
        const id = `${k.stepId}:${k.role}`
        return {
          id,
          source: k.stepId,
          target: k.folderId,
          sourceHandle: k.role,
          targetHandle: 'folder',
          className: `loop-edge is-${k.role}${picked(id)}`,
          label: k.role,
          markerEnd: k.role === 'output' ? arrow('var(--grey-2)') : undefined,
          markerStart: k.role === 'input' ? arrow('var(--grey-2)') : undefined,
          data: { sel: { kind: 'link', id } }
        }
      }),
      ...graph.folders.filter((f) => f.parentId).map((f) => ({ id: `in:${f.id}`, source: f.parentId!, target: f.id, sourceHandle: 'sub', targetHandle: 'folder', className: 'loop-edge is-nested' }))
    ]
  }, [graph.edges, graph.links, graph.folders, sel])

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
    for (const c of changes) if (c.type === 'position' && c.position) onMove?.(c.id, c.position)
  }

  return (
    <div className="loop-graph">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={loopNodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          isValidConnection={validConnection}
          nodesConnectable={editable}
          nodesDraggable={editable}
          elementsSelectable={false}
          edgesFocusable={false}
          onNodeClick={(_, n) => onSelect({ kind: n.type === 'step' ? 'step' : 'folder', id: n.id })}
          onEdgeClick={(_, e) => e.data?.sel && onSelect(e.data.sel as Sel)}
          onPaneClick={() => onSelect(null)}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          // No canvas keyboard shortcuts: they would swallow keys typed in the panel.
          deleteKeyCode={null}
          panActivationKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomActivationKeyCode={null}
          disableKeyboardA11y
          zoomOnDoubleClick={false}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <FitOnAdd count={nodes.length} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}

// ---------- editor ----------

function LoopEditor({ machineId, loop, onCreated }: { machineId?: string; loop?: LoopInfo; onCreated: (l: LoopInfo) => void }) {
  const [draft, setDraft] = useState<LoopDraft>(() =>
    loop
      ? structuredClone({ name: loop.name, steps: loop.steps, folders: loop.folders, links: loop.links, edges: loop.edges, start: loop.start, maxRuns: loop.maxRuns, optimize: loop.optimize !== false })
      : starter(machineId)
  )
  const [sel, setSel] = useState<Sel>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (fn: (d: LoopDraft) => LoopDraft) => setDraft(fn)
  const addStep = (kind: LoopStepKind) => {
    const step = newStep(kind, machineId, { x: Math.max(-340, ...draft.steps.map((s) => s.position.x)) + 340, y: 0 })
    update((d) => ({ ...d, steps: [...d.steps, step], start: d.start ?? step.id }))
    setSel({ kind: 'step', id: step.id })
  }
  const addFolder = (parent?: LoopFolder) => {
    const siblings = draft.folders.filter((f) => f.parentId === parent?.id && (parent || f.path === undefined)).map((f) => f.name)
    const folder: LoopFolder = {
      id: uid(),
      name: freeName(parent ? 'sub' : 'folder', siblings),
      parentId: parent?.id,
      position: parent ? { x: parent.position.x + 30, y: parent.position.y + 90 } : { x: Math.max(-180, ...draft.folders.map((f) => f.position.x)) + 180, y: 190 }
    }
    update((d) => ({ ...d, folders: [...d.folders, folder] }))
    setSel({ kind: 'folder', id: folder.id })
  }
  const connect = (c: Connection) =>
    update((d) => {
      if (c.sourceHandle === 'next') return d.edges.some((e) => e.from === c.source && e.to === c.target) ? d : { ...d, edges: [...d.edges, { id: uid(), from: c.source, to: c.target }] }
      const role = c.sourceHandle as LoopFolderRole
      return { ...d, links: [...d.links.filter((k) => !(k.stepId === c.source && k.role === role)), { stepId: c.source, folderId: c.target, role }] }
    })
  const changeStep = (id: string, p: Partial<LoopStep>) =>
    update((d) => ({ ...d, steps: swap(d.steps, id, p), links: p.kind === 'human' ? d.links.filter((k) => k.stepId !== id || k.role === 'input') : d.links }))
  const remove = (id: string) => {
    update((d) => without(d, id))
    setSel(null)
  }

  const save = async (): Promise<LoopInfo | null> => {
    setError(null)
    try {
      if (loop) return await api.loopUpdate(loop.id, draft)
      const created = await api.loopCreate(draft, machineId)
      onCreated(created)
      return created
    } catch (err) {
      setError(cleanError(err))
      return null
    }
  }

  const start = async () => {
    setBusy(true)
    const saved = await save()
    if (saved) await api.loopStart(saved.id).catch((err: Error) => setError(cleanError(err)))
    setBusy(false)
  }

  const step = sel?.kind === 'step' ? draft.steps.find((s) => s.id === sel.id) : undefined
  const folder = sel?.kind === 'folder' ? draft.folders.find((f) => f.id === sel.id) : undefined
  const edge = sel?.kind === 'edge' ? draft.edges.find((e) => e.id === sel.id) : undefined
  const link = sel?.kind === 'link' ? draft.links.find((k) => `${k.stepId}:${k.role}` === sel.id) : undefined

  return (
    <div className="loop-editor">
      <input className="loop-name" placeholder="Loop name, e.g. Report design" value={draft.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} />
      <div className="loop-add">
        <button className="btn ghost" onClick={() => addStep('agent')}>
          + Agent step
        </button>
        <button className="btn ghost" onClick={() => addStep('human')}>
          + Human review
        </button>
        <button className="btn ghost" onClick={() => addFolder()}>
          + Folder
        </button>
        <span className="spacer" />
        <label className="loop-limit" title="Agent steps in a row without a human decision before the loop pauses">
          Pause after
          <input type="number" min={1} max={100} value={draft.maxRuns} onChange={(e) => update((d) => ({ ...d, maxRuns: Number(e.target.value) }))} />
          agent runs
        </label>
      </div>
      <LoopGraph
        graph={draft}
        sel={sel}
        onSelect={setSel}
        onConnect={connect}
        onMove={(id, position) => update((d) => ({ ...d, steps: swap(d.steps, id, { position }), folders: swap(d.folders, id, { position }) }))}
      />
      {step ? (
        <StepCard
          key={step.id}
          step={step}
          machineId={machineId}
          start={draft.start === step.id}
          onChange={(p) => changeStep(step.id, p)}
          onStart={() => update((d) => ({ ...d, start: step.id }))}
          onRemove={() => remove(step.id)}
        />
      ) : folder ? (
        <FolderCard
          key={folder.id}
          folder={folder}
          graph={draft}
          machineId={machineId}
          onChange={(p) => update((d) => ({ ...d, folders: swap(d.folders, folder.id, p) }))}
          onSubfolder={() => addFolder(folder)}
          onRemove={() => remove(folder.id)}
        />
      ) : edge ? (
        <EdgeCard key={edge.id} edge={edge} graph={draft} onChange={(prompt) => update((d) => ({ ...d, edges: swap(d.edges, edge.id, { prompt }) }))} onRemove={() => (update((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) })), setSel(null))} />
      ) : link ? (
        <div className="step-card">
          <div className="step-head">
            <span className="loop-card-text">
              {titleOf(draft, link.stepId)} uses {draft.folders.find((f) => f.id === link.folderId)?.name} as its {link.role} folder
            </span>
            <button className="icon-btn" title="Remove this connection" onClick={() => (update((d) => ({ ...d, links: d.links.filter((k) => k !== link) })), setSel(null))}>
              <IconClose />
            </button>
          </div>
        </div>
      ) : (
        <p className="loop-hint">
          Click a step, folder or connection to edit it. Drag from a step's right side to the step that comes next, and from its session, input or output handle to a folder.
          Steps share work only through folders.
        </p>
      )}
      {error && <p className="loop-error">{error}</p>}
      <div className="loop-foot">
        <label className="opt-toggle">
          <input type="checkbox" checked={draft.optimize} onChange={(e) => update((d) => ({ ...d, optimize: e.target.checked }))} />
          Optimize prompts
        </label>
        <span className="hint">{draft.optimize ? 'Agent prompts are improved with /optimize-prompt when the loop starts.' : 'Agent steps run with their prompts as written.'}</span>
        <button className="btn" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button className="btn primary" disabled={busy || !draft.steps.length} onClick={() => void start()}>
          {loop && loop.state !== 'draft' ? 'Run again' : 'Start'}
        </button>
      </div>
    </div>
  )
}

function StepCard({
  step,
  machineId,
  start,
  onChange,
  onStart,
  onRemove
}: {
  step: LoopStep
  machineId?: string
  start: boolean
  onChange: (p: Partial<LoopStep>) => void
  onStart: () => void
  onRemove: () => void
}) {
  const human = step.kind === 'human'
  const area = useRef<HTMLTextAreaElement>(null)
  const dictation = useDictation(step.prompt, (t) => onChange({ prompt: t }), area)
  const dictating = dictation.state !== 'idle'
  const onPaste = (e: React.ClipboardEvent) => {
    if (human) return
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    void Promise.all(files.map((f) => readImage(f).catch(() => null))).then((read) =>
      onChange({ images: [...(step.images ?? []), ...read.filter((r) => !!r)] })
    )
  }
  const setKind = (kind: LoopStepKind) => {
    if (kind === step.kind) return
    const c = machineConfig(useStore.getState(), machineId)
    onChange(kind === 'agent' ? { kind, model: c.defaultModel, effort: c.efforts[c.defaultModel], images: [] } : { kind, model: undefined, effort: undefined, images: undefined })
  }
  return (
    <div className={`step-card${human ? ' is-human' : ''}`}>
      <div className="step-head">
        <span className={`pip ${step.kind} is-current`} />
        <div className="seg">
          <button className={human ? '' : 'is-on'} onClick={() => setKind('agent')}>
            Agent
          </button>
          <button className={human ? 'is-on' : ''} onClick={() => setKind('human')}>
            Human review
          </button>
        </div>
        <input className="step-title" placeholder={human ? 'e.g. Final approval' : 'e.g. Implement design'} value={step.title} onChange={(e) => onChange({ title: e.target.value })} />
        <MicButton d={dictation} />
        <button className="btn ghost small" disabled={start} title="Every run starts at this step" onClick={onStart}>
          {start ? 'Start step' : 'Start here'}
        </button>
        <button className="icon-btn" title="Remove step" onClick={onRemove}>
          <IconClose />
        </button>
      </div>
      <div className="dictation-field">
        <textarea
          ref={area}
          className={`step-prompt${dictating ? ' is-dictating' : ''}`}
          readOnly={dictating}
          rows={human ? 2 : 4}
          placeholder={
            human
              ? 'What should you check here? (optional) You review the files in this step\'s input folder.'
              : 'What should this step do? It is told where its input and output folders are. Paste images with Ctrl+V. With several steps after it, it picks the one the loop goes to.'
          }
          value={step.prompt}
          onPaste={onPaste}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        <DictationOverlay d={dictation} area={area} />
      </div>
      <DictationStatus d={dictation} />
      {!human && (
        <>
          <Attachments images={step.images ?? []} onRemove={(i) => onChange({ images: (step.images ?? []).filter((_, j) => j !== i) })} />
          <div className="step-opts">
            <ModelSelect
              machineId={machineId}
              value={step.model ?? machineConfig(useStore.getState(), machineId).defaultModel}
              onChange={(m) => onChange({ model: m, effort: machineConfig(useStore.getState(), machineId).efforts[m] })}
            />
            <EffortSelect machineId={machineId} model={step.model ?? ''} value={step.effort ?? ''} onChange={(v) => onChange({ effort: (v || undefined) as EffortLevel | undefined })} />
          </div>
        </>
      )}
    </div>
  )
}

function FolderCard({
  folder,
  graph,
  machineId,
  onChange,
  onSubfolder,
  onRemove
}: {
  folder: LoopFolder
  graph: Graph
  machineId?: string
  onChange: (p: Partial<LoopFolder>) => void
  onSubfolder: () => void
  onRemove: () => void
}) {
  const projects = useStore((s) => s.projects)
  const parent = graph.folders.find((f) => f.id === folder.parentId)
  const users = graph.links.filter((k) => k.folderId === folder.id)
  const temporary = folder.path === undefined
  return (
    <div className="step-card">
      <div className="step-head">
        <IconFolder />
        <input className="step-title" placeholder="Folder name" value={folder.name} onChange={(e) => onChange({ name: e.target.value })} />
        {!parent && (
          <div className="seg">
            <button className={temporary ? 'is-on' : ''} onClick={() => onChange({ path: undefined })}>
              Temporary
            </button>
            <button className={temporary ? '' : 'is-on'} onClick={() => onChange({ path: folder.path ?? '' })}>
              Existing folder
            </button>
          </div>
        )}
        <button className="btn ghost small" onClick={onSubfolder}>
          + Subfolder
        </button>
        <button className="icon-btn" title="Remove folder (and its subfolders)" onClick={onRemove}>
          <IconClose />
        </button>
      </div>
      {parent ? (
        <p className="loop-hint">Inside "{parent.name}", and temporary when it is.</p>
      ) : temporary ? (
        <p className="loop-hint">Created for this loop on its machine, kept between runs, deleted with the loop.</p>
      ) : (
        <div className="step-opts">
          <input className="loop-path" list={`paths-${folder.id}`} placeholder="Full path on the loop's machine" value={folder.path} onChange={(e) => onChange({ path: e.target.value })} />
          <datalist id={`paths-${folder.id}`}>
            {Object.values(projects)
              .filter((p) => p.machineId === machineId)
              .map((p) => (
                <option key={p.id} value={p.path} />
              ))}
          </datalist>
          {!machineId && (
            <button className="btn" onClick={() => void api.remotePickFolder().then((path) => path && onChange({ path }))}>
              Browse…
            </button>
          )}
        </div>
      )}
      <p className="loop-hint">
        {users.length
          ? `Used by ${users.map((k) => `${titleOf(graph, k.stepId)} (${k.role})`).join(', ')}.`
          : "Not used yet: drag from a step's session, input or output handle to it."}
      </p>
    </div>
  )
}

function EdgeCard({ edge, graph, onChange, onRemove }: { edge: LoopEdge; graph: Graph; onChange: (prompt: string) => void; onRemove: () => void }) {
  return (
    <div className="step-card">
      <div className="step-head">
        <span className="loop-card-text">
          {titleOf(graph, edge.from)} → {titleOf(graph, edge.to)}
        </span>
        <button className="icon-btn" title="Remove this edge" onClick={onRemove}>
          <IconClose />
        </button>
      </div>
      <textarea
        className="step-prompt"
        rows={3}
        placeholder={`Prompt for ${titleOf(graph, edge.to)} when the loop comes from ${titleOf(graph, edge.from)} (optional). It goes in front of that step's own prompt.`}
        value={edge.prompt ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// ---------- running ----------

function LoopRun({ loop }: { loop: LoopInfo }) {
  const [sel, setSel] = useState<Sel>(null)
  const step = sel?.kind === 'step' ? loop.steps.find((s) => s.id === sel.id) : undefined
  return (
    <div className="loop-run">
      {(loop.state === 'waiting' || loop.state === 'paused') && <Decision key={`${loop.history.length}:${loop.current}:${loop.state}`} loop={loop} />}
      <LoopGraph graph={loop} current={loop.current} sel={sel} onSelect={setSel} />
      {step ? (
        <StepDetail loop={loop} step={step} />
      ) : sel?.kind === 'folder' ? (
        <FolderFiles key={sel.id} loop={loop} folderId={sel.id} />
      ) : (
        <p className="loop-hint">Click a step to see its prompt, or a folder to see what is in it.</p>
      )}
    </div>
  )
}

function StepDetail({ loop, step }: { loop: LoopInfo; step: LoopStep }) {
  const model = useModelLabel(step.model ?? '', loop.machineId)
  const runs = loop.history.filter((h) => h.from === step.id && h.by === 'agent').length + (loop.current === step.id && loop.state === 'running' ? 1 : 0)
  const optimized = loop.optimize !== false ? step.optimized : undefined
  return (
    <div className="loop-detail">
      <div className="detail-label">
        {step.title} · {step.kind === 'human' ? 'human review' : model}
        {runs > 0 && ` · ${runs} ${runs === 1 ? 'run' : 'runs'}`}
      </div>
      {optimized ? (
        <>
          <div className="detail-label">Improved prompt</div>
          <div className="code-block">{optimized}</div>
          <div className="detail-label">Your prompt</div>
          <div className="code-block">{step.prompt}</div>
        </>
      ) : (
        <div className="code-block">{step.prompt || '(no instructions)'}</div>
      )}
    </div>
  )
}

/** The files in a loop folder, newest first. Not buttons: looking is allowed while the loop is locked. */
function FolderFiles({ loop, folderId }: { loop: LoopInfo; folderId: string }) {
  const [files, setFiles] = useState<LoopFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    setError(null)
    api.loopFiles(loop.id, folderId).then(setFiles, (err) => setError(cleanError(err)))
  }
  useEffect(load, [loop.id, folderId, loop.history.length])
  return (
    <div className="loop-files">
      <div className="history-head">
        <span className="history-move detail-label">
          {loop.folders.find((f) => f.id === folderId)?.name}
          {files && ` · ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        </span>
        <Viewable className="btn ghost small" title="List the files again" onOpen={load}>
          Refresh
        </Viewable>
      </div>
      {files?.map((f) => (
        <Viewable
          key={f.path}
          className="artifact"
          title={f.path}
          onOpen={() => {
            setError(null)
            api.loopOpenFile(loop.id, folderId, f.path).then(setError, (err) => setError(cleanError(err)))
          }}
        >
          <span className="artifact-label">{f.path}</span>
          <span className="artifact-target">
            {sizeText(f.size)} · {clock(f.modified)}
          </span>
        </Viewable>
      ))}
      {files && !files.length && <p className="loop-hint">Nothing here yet.</p>}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

/** The user's turn: a human review step, or a loop that paused and needs routing. */
function Decision({ loop }: { loop: LoopInfo }) {
  const step = loop.steps.find((s) => s.id === loop.current)
  const waiting = loop.state === 'waiting'
  const out = loop.edges.filter((e) => e.from === loop.current)
  // Agent steps this run has been through: where the loop can be sent back to.
  const earlier = loop.steps.filter((s) => s.kind === 'agent' && loop.history.some((h) => h.from === s.id && h.decision !== 'stop'))
  const [edge, setEdge] = useState(out[0]?.id ?? '')
  const [backTo, setBackTo] = useState(earlier.at(-1)?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!step) return null
  const input = loop.links.find((k) => k.stepId === step.id && k.role === 'input')?.folderId
  const next = out.length === 1 ? ` to ${titleOf(loop, out[0].to)}` : ''
  const decide = (decision: 'forward' | 'back') => {
    setError(null)
    api.loopDecide(loop.id, { decision, edge, step: backTo, prompt }).catch((err) => setError(cleanError(err)))
  }

  return (
    <div className="t-request loop-decision">
      <div className="t-request-head">
        <Glyph status="input" size={10} />
        <span>{waiting ? `Your review: ${step.title}` : `Paused at ${step.title}`}</span>
      </div>
      {waiting ? step.prompt && <Markdown text={step.prompt} /> : <p className="loop-reason">{loop.pausedReason}</p>}
      {waiting && input && <FolderFiles loop={loop} folderId={input} />}
      <div className="t-request-actions">
        {out.length > 1 && (
          <select className="model" value={edge} onChange={(e) => setEdge(e.target.value)} title="Where the loop goes next">
            {out.map((e) => (
              <option key={e.id} value={e.id}>
                {titleOf(loop, e.to)}
              </option>
            ))}
          </select>
        )}
        <button className="btn signal" onClick={() => decide('forward')}>
          {!out.length ? (waiting ? 'Approve and finish' : 'Finish loop') : waiting ? `Approve, continue${next}` : `Continue${next}`}
        </button>
        {!waiting && (
          <button className="btn" onClick={() => void api.loopStart(loop.id).catch((err) => setError(cleanError(err)))}>
            Rerun this step
          </button>
        )}
      </div>
      {earlier.length > 0 && (
        <>
          <textarea
            className="step-prompt"
            rows={3}
            placeholder="To send the loop back: what has to change. It goes in front of that step's own prompt."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="t-request-actions">
            <select className="model" value={backTo} onChange={(e) => setBackTo(e.target.value)} title="Step to send the loop back to">
              {earlier.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!prompt.trim()} onClick={() => decide('back')}>
              Send back
            </button>
          </div>
        </>
      )}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

function History({ loop }: { loop: LoopInfo }) {
  const sessions = useStore((s) => s.sessions)
  const items = [...loop.history].reverse()
  return (
    <div className="loop-history">
      <div className="detail-label">History</div>
      {items.map((h, i) => (
        <HistoryItem key={loop.history.length - i} loop={loop} h={h} hasSession={!!h.sessionId && !!sessions[h.sessionId]} />
      ))}
    </div>
  )
}

function HistoryItem({ loop, h, hasSession }: { loop: LoopInfo; h: LoopMove; hasSession: boolean }) {
  const move = h.decision === 'stop' ? 'stopped' : h.to === null ? 'finished the loop' : h.decision === 'back' ? `sent back to ${titleOf(loop, h.to)}` : `moved on to ${titleOf(loop, h.to)}`
  return (
    <div className="history-item">
      <div className="history-head">
        <span className="history-move">
          {titleOf(loop, h.from)} {move}
        </span>
        <span className="history-meta">
          {h.by === 'human' ? 'you' : 'agent'} · {clock(h.at)}
        </span>
        {hasSession && (
          <button className="btn ghost small" onClick={() => useStore.getState().openPanel('session', h.sessionId!)}>
            Open session
          </button>
        )}
      </div>
      {h.prompt && <Markdown text={h.prompt} />}
    </div>
  )
}
