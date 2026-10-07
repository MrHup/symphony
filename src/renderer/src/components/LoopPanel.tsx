import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffortLevel, LoopArtifact, LoopDraft, LoopHandoff, LoopInfo, LoopStep, LoopStepKind } from '@shared/types'
import { readImage } from '../images'
import { api, loopStatus, useStore, type Panel } from '../store'
import { Attachments } from './Attachments'
import { useDictation } from '../speech/dictation'
import { DictationOverlay, DictationStatus, MicButton } from './Dictate'
import { EffortSelect, ModelSelect } from './Composer'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'
import { IconClose, IconTrash } from './icons'
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

function newStep(kind: LoopStepKind): LoopStep {
  const s = useStore.getState()
  const model = s.defaultModel
  return {
    id: crypto.randomUUID(),
    kind,
    title: '',
    prompt: '',
    ...(kind === 'agent' ? { model, effort: s.efforts[model], images: [] } : {})
  }
}

export function LoopPanel({ panel }: { panel: Panel }) {
  const isNew = panel.targetId.startsWith('new:')
  const loop = useStore((s) => (isNew ? undefined : s.loops[panel.targetId]))
  const sessions = useStore((s) => s.sessions)
  const projectId = isNew ? panel.targetId.slice(4).split('#')[0] : loop?.projectId
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  if (!project || (!isNew && !loop)) return null
  const status = loop ? loopStatus(loop, sessions) : 'idle'
  const active = !!loop && ACTIVE.includes(loop.state)

  return (
    <FloatingPanel
      panel={panel}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <Glyph status={status} size={12} variant="loop" />
          {loop?.name ?? 'New loop'}
        </span>
      }
      meta={`${project.name}${loop ? ` · ${STATE_LABEL[loop.state]}${loop.runs ? ` · ${loop.runs} runs` : ''}` : ''}`}
      actions={
        loop &&
        (active ? (
          <button className="btn ghost" onClick={() => void api.loopStop(loop.id)}>
            Stop loop
          </button>
        ) : (
          <button className="icon-btn" title="Delete loop" onClick={() => void api.loopDelete(loop.id)}>
            <IconTrash />
          </button>
        ))
      }
    >
      <div className="loop-body">
        {active && loop ? (
          <LoopRun loop={loop} />
        ) : (
          <LoopEditor
            key={loop?.id ?? panel.targetId}
            projectId={project.id}
            loop={loop}
            onCreated={(created) => useStore.getState().updatePanel(panel.id, { targetId: created.id })}
          />
        )}
        {loop && loop.history.length > 0 && <History loop={loop} />}
      </div>
    </FloatingPanel>
  )
}

// ---------- editor ----------

function LoopEditor({ projectId, loop, onCreated }: { projectId: string; loop?: LoopInfo; onCreated: (l: LoopInfo) => void }) {
  const [name, setName] = useState(loop?.name ?? '')
  const [steps, setSteps] = useState<LoopStep[]>(() => (loop ? structuredClone(loop.steps) : [newStep('agent'), newStep('human')]))
  const [maxRuns, setMaxRuns] = useState(loop?.maxRuns ?? DEFAULT_MAX_RUNS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const draft: LoopDraft = { name, steps, maxRuns }
  const ready = steps.length > 0 && steps.every((s) => s.kind === 'human' || s.prompt.trim())

  const patch = (i: number, p: Partial<LoopStep>) => setSteps((cur) => cur.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const move = (i: number, d: number) =>
    setSteps((cur) => {
      const next = [...cur]
      const [s] = next.splice(i, 1)
      next.splice(Math.max(0, Math.min(next.length, i + d)), 0, s)
      return next
    })

  const save = async (): Promise<LoopInfo | null> => {
    setError(null)
    try {
      if (loop) return await api.loopUpdate(loop.id, draft)
      const created = await api.loopCreate(projectId, draft)
      onCreated(created)
      return created
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      return null
    }
  }

  const start = async () => {
    setBusy(true)
    const saved = await save()
    if (saved) await api.loopStart(saved.id).catch((err: Error) => setError(err.message))
    setBusy(false)
  }

  return (
    <div className="loop-editor">
      <input className="loop-name" placeholder="Loop name, e.g. Report design" value={name} onChange={(e) => setName(e.target.value)} />
      {steps.map((s, i) => (
        <StepCard
          key={s.id}
          index={i}
          step={s}
          count={steps.length}
          onChange={(p) => patch(i, p)}
          onMove={(d) => move(i, d)}
          onRemove={() => setSteps((cur) => cur.filter((_, j) => j !== i))}
        />
      ))}
      <div className="loop-add">
        <button className="btn ghost" onClick={() => setSteps((cur) => [...cur, newStep('agent')])}>
          + Agent step
        </button>
        <button className="btn ghost" onClick={() => setSteps((cur) => [...cur, newStep('human')])}>
          + Human review
        </button>
        <span className="spacer" />
        <label className="loop-limit" title="Agent steps in a row without a human decision before the loop pauses">
          Pause after
          <input type="number" min={1} max={100} value={maxRuns} onChange={(e) => setMaxRuns(Number(e.target.value))} />
          agent runs
        </label>
      </div>
      {error && <p className="loop-error">{error}</p>}
      <div className="loop-foot">
        <span className="hint">Agent prompts are improved with /optimize-prompt when the loop starts.</span>
        <button className="btn" disabled={busy || !ready} onClick={() => void save()}>
          Save
        </button>
        <button className="btn primary" disabled={busy || !ready} onClick={() => void start()}>
          {loop && loop.state !== 'draft' ? 'Run again' : 'Start'}
        </button>
      </div>
    </div>
  )
}

function StepCard({
  index,
  step,
  count,
  onChange,
  onMove,
  onRemove
}: {
  index: number
  step: LoopStep
  count: number
  onChange: (p: Partial<LoopStep>) => void
  onMove: (d: number) => void
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
    const s = useStore.getState()
    onChange(kind === 'agent' ? { kind, model: s.defaultModel, effort: s.efforts[s.defaultModel], images: [] } : { kind, model: undefined, effort: undefined, images: undefined })
  }
  return (
    <div className={`step-card${human ? ' is-human' : ''}`}>
      <div className="step-head">
        <span className={`pip ${step.kind} is-current`} />
        <span className="step-num">{index + 1}</span>
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
        <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button className="icon-btn" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          ↓
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
              ? 'What should you check here? (optional) The previous step hands over its summary and the files or links to review.'
              : 'What should this step do? Paste images with Ctrl+V. The step decides whether to move forward or send the work back.'
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
            <ModelSelect value={step.model ?? useStore.getState().defaultModel} onChange={(m) => onChange({ model: m, effort: useStore.getState().efforts[m] })} />
            <EffortSelect model={step.model ?? ''} value={step.effort ?? ''} onChange={(v) => onChange({ effort: (v || undefined) as EffortLevel | undefined })} />
          </div>
        </>
      )}
    </div>
  )
}

// ---------- running ----------

function LoopRun({ loop }: { loop: LoopInfo }) {
  return (
    <div className="loop-run">
      {(loop.state === 'waiting' || loop.state === 'paused') && <Decision key={`${loop.history.length}:${loop.current}:${loop.state}`} loop={loop} />}
      <div className="loop-steps">
        {loop.steps.map((s, i) => (
          <StepRow key={s.id} loop={loop} step={s} index={i} />
        ))}
      </div>
    </div>
  )
}

function StepRow({ loop, step, index }: { loop: LoopInfo; step: LoopStep; index: number }) {
  const [open, setOpen] = useState(false)
  const model = useModelLabel(step.model ?? '')
  const current = loop.current === index
  const runs = loop.history.filter((h) => h.fromStep === index && h.by === 'agent').length + (current && loop.state === 'running' ? 1 : 0)
  return (
    <div className={`step-row${current ? ' is-current' : ''}`}>
      <button className="step-row-head" onClick={() => setOpen((o) => !o)}>
        <span className={`pip ${step.kind}${current ? ' is-current' : loop.current !== null && index < loop.current ? ' is-past' : ''}`} />
        <span className="step-num">{index + 1}</span>
        <span className="step-row-title">{step.title}</span>
        <span className="step-row-meta">
          {step.kind === 'human' ? 'human review' : model}
          {runs > 0 && ` · ${runs} ${runs === 1 ? 'run' : 'runs'}`}
          {step.optimized && ' · improved'}
        </span>
      </button>
      {open && (
        <div className="step-row-detail">
          {step.optimized ? (
            <>
              <div className="detail-label">Improved prompt</div>
              <div className="code-block">{step.optimized}</div>
              <div className="detail-label">Your prompt</div>
              <div className="code-block">{step.prompt}</div>
            </>
          ) : (
            <div className="code-block">{step.prompt || '(no instructions)'}</div>
          )}
        </div>
      )}
    </div>
  )
}

function Artifacts({ projectId, artifacts }: { projectId: string; artifacts: LoopArtifact[] }) {
  const [error, setError] = useState<string | null>(null)
  if (!artifacts.length) return null
  return (
    <div className="artifacts">
      {artifacts.map((a, i) => (
        <button
          key={i}
          className="artifact"
          title={a.path ?? a.url}
          onClick={async () => {
            setError(null)
            setError(await api.openArtifact(projectId, a))
          }}
        >
          <span className="artifact-label">{a.label}</span>
          <span className="artifact-target">{a.path ?? a.url}</span>
        </button>
      ))}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

/** The user's turn: a human review step, or a loop that paused and needs routing. */
function Decision({ loop }: { loop: LoopInfo }) {
  const [feedback, setFeedback] = useState('')
  const current = loop.current ?? 0
  const step = loop.steps[current]
  const waiting = loop.state === 'waiting'
  const last = loop.history.at(-1)
  const isLast = current === loop.steps.length - 1
  // Earlier steps only; rerunning the current step has its own button.
  const backOptions = useMemo(() => loop.steps.map((s, i) => ({ i, s })).filter(({ i }) => i < current), [loop.steps, current])
  const [backTo, setBackTo] = useState<number>(backOptions.at(-1)?.i ?? 0)
  useEffect(() => setBackTo(backOptions.at(-1)?.i ?? 0), [backOptions])
  const decide = (decision: 'forward' | 'back') => void api.loopDecide(loop.id, { decision, step: decision === 'back' ? backTo : undefined, feedback })

  return (
    <div className="t-request loop-decision">
      <div className="t-request-head">
        <Glyph status="input" size={10} />
        <span>{waiting ? `Your review: step ${current + 1}, ${step.title}` : `Paused at step ${current + 1}, ${step.title}`}</span>
      </div>
      {waiting ? step.prompt && <Markdown text={step.prompt} /> : <p className="loop-reason">{loop.pausedReason}</p>}
      {last && last.decision !== 'stop' && (
        <div className="handoff">
          <div className="detail-label">
            {last.by === 'human' ? 'Your notes' : `Step ${last.fromStep + 1} ${last.decision === 'back' ? 'sent the work back' : 'handed over'}`}
          </div>
          <Markdown text={last.summary} />
          <Artifacts projectId={loop.projectId} artifacts={last.artifacts} />
        </div>
      )}
      <textarea
        className="step-prompt"
        rows={3}
        placeholder={waiting ? 'Notes for the step that runs next (needed when you send work back)' : 'Notes for the step that runs next (optional)'}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="t-request-actions">
        <button className="btn signal" onClick={() => decide('forward')}>
          {isLast ? (waiting ? 'Approve and finish' : 'Finish loop') : waiting ? `Approve, continue to step ${current + 2}` : `Continue to step ${current + 2}`}
        </button>
        {!waiting && step.kind === 'agent' && (
          <button className="btn" onClick={() => void api.loopStart(loop.id)}>
            Rerun this step
          </button>
        )}
        {backOptions.length > 0 && (
          <>
            <select className="model" value={backTo} onChange={(e) => setBackTo(Number(e.target.value))} title="Step to return to">
              {backOptions.map(({ i, s }) => (
                <option key={s.id} value={i}>
                  {i + 1}. {s.title}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => decide('back')}>
              Send back
            </button>
          </>
        )}
      </div>
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

function HistoryItem({ loop, h, hasSession }: { loop: LoopInfo; h: LoopHandoff; hasSession: boolean }) {
  const from = `${h.fromStep + 1}. ${loop.steps[h.fromStep]?.title ?? ''}`
  const move =
    h.decision === 'stop' ? 'stopped' : h.toStep === null ? 'finished the loop' : h.decision === 'back' ? `sent back to ${h.toStep + 1}` : `moved on to ${h.toStep + 1}`
  return (
    <div className="history-item">
      <div className="history-head">
        <span className="history-move">
          {from} {move}
        </span>
        <span className="history-meta">
          {h.by === 'human' ? 'you' : 'agent'} · {new Date(h.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        {hasSession && (
          <button className="btn ghost small" onClick={() => useStore.getState().openPanel('session', h.sessionId!)}>
            Open session
          </button>
        )}
      </div>
      {h.decision !== 'stop' && <Markdown text={h.summary} />}
      <Artifacts projectId={loop.projectId} artifacts={h.artifacts} />
    </div>
  )
}
