import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EFFORT_LABELS, type EffortLevel, type ModelOption } from '@shared/types'
import { usePastedImages } from '../images'
import { api, useStore } from '../store'
import { Attachments } from './Attachments'

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The models Claude Code reports, or the CLI aliases until that list arrives. */
function useModels(): ModelOption[] {
  const models = useStore((s) => s.models)
  return models.length
    ? models
    : [
        { value: 'opus', label: 'Opus', efforts: ALL_EFFORTS },
        { value: 'sonnet', label: 'Sonnet', efforts: ALL_EFFORTS },
        { value: 'haiku', label: 'Haiku', efforts: [] }
      ]
}

/** Effort the composer should start with for a model: the one last used with it, if the model still accepts it. */
function rememberedEffort(model: string, models: ModelOption[]): EffortLevel | '' {
  const saved = useStore.getState().efforts[model]
  const levels = models.find((m) => m.value === model)?.efforts ?? []
  return saved && levels.includes(saved) ? saved : ''
}

export function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useModels()
  const options = list.some((m) => m.value === value) ? list : [{ value, label: value, efforts: [] }, ...list]
  return (
    <select className="model" value={value} onChange={(e) => onChange(e.target.value)} title="Model">
      {options.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  )
}

/** Effort picker for the selected model. Lists only the levels that model accepts; hidden for models without effort. */
export function EffortSelect({ model, value, onChange }: { model: string; value: EffortLevel | ''; onChange: (v: EffortLevel | '') => void }) {
  const levels = useModels().find((m) => m.value === model)?.efforts ?? []
  if (!levels.length) return null
  return (
    <select className="model" value={value} onChange={(e) => onChange(e.target.value as EffortLevel | '')} title="Effort">
      <option value="">Default effort</option>
      {levels.map((l) => (
        <option key={l} value={l}>
          {EFFORT_LABELS[l]} effort
        </option>
      ))}
    </select>
  )
}

/**
 * The bubble that opens on right-click. On a project it feeds the prompt pipeline; on a skill or
 * MCP server it starts a session that makes the requested change.
 */
export function ComposerBubble() {
  const composer = useStore((s) => s.composer)
  const defaultModel = useStore((s) => s.defaultModel)
  const project = useStore((s) => (composer?.kind === 'project' ? s.projects[composer.targetId] : undefined))
  const skill = useStore((s) => (composer?.kind === 'skill' ? s.skills.find((k) => k.id === composer.targetId) : undefined))
  const mcp = useStore((s) => (composer?.kind === 'mcp' ? s.mcp.find((m) => m.id === composer.targetId) : undefined))
  const [text, setText] = useState('')
  const models = useModels()
  const [model, setModel] = useState(defaultModel)
  const [effort, setEffort] = useState<EffortLevel | ''>('')
  const [busy, setBusy] = useState(false)
  const pasted = usePastedImages()
  const ref = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [side, setSide] = useState<'right' | 'left'>('right')

  useEffect(() => {
    setText('')
    pasted.clear()
    setBusy(false)
    setModel(useStore.getState().defaultModel)
    requestAnimationFrame(() => area.current?.focus())
  }, [composer?.targetId, composer?.kind])

  // Each model keeps its own effort: switching models (or the model list arriving) restores that model's last choice.
  useEffect(() => {
    setEffort(rememberedEffort(model, models))
  }, [model, models])

  useLayoutEffect(() => {
    if (!composer || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    // Open beside the node, flipping to its left when the right side has no room, so it never covers the node.
    const fitsRight = composer.right + 14 + width <= window.innerWidth - 16
    setSide(fitsRight ? 'right' : 'left')
    setPos({
      left: fitsRight ? composer.right + 14 : Math.max(16, composer.left - 14 - width),
      top: Math.min(Math.max(48, composer.top - 8), window.innerHeight - height - 16)
    })
  }, [composer])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  if (!composer) return null
  const close = () => useStore.getState().setComposer(null)
  const target = project?.path ?? skill?.path ?? (mcp ? `MCP · ${mcp.name}` : '')
  const placeholder = project ? `What should Claude do in ${project.name}?` : skill ? `How should ${skill.name} change?` : `What should change about ${mcp?.name ?? 'this server'}?`

  const submit = async () => {
    const prompt = text.trim()
    if (!prompt || busy) return
    setBusy(true)
    useStore.getState().setDefaultModel(model)
    try {
      if (composer.kind === 'project') await api.startPipeline(composer.targetId, prompt, model, effort || undefined, pasted.images)
      else await api.startConfigSession(composer.targetId, prompt, model, effort || undefined, pasted.images)
      close()
    } catch (err) {
      setBusy(false)
      console.error(err)
    }
  }

  return (
    <div
      ref={ref}
      className={`composer from-${side}`}
      style={pos}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      }}
    >
      <div className="composer-target" title={target}>
        {target}
      </div>
      <textarea
        ref={area}
        value={text}
        placeholder={placeholder}
        onPaste={pasted.onPaste}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <Attachments images={pasted.images} onRemove={pasted.remove} />
      <div className="composer-foot">
        <ModelSelect value={model} onChange={setModel} />
        <EffortSelect
          model={model}
          value={effort}
          onChange={(v) => {
            // Saved right away, so each model keeps its own effort even when you switch models before starting.
            setEffort(v)
            useStore.getState().setModelEffort(model, v || null)
          }}
        />
        <span className="spacer" />
        <kbd>{window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter</kbd>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
          Start
        </button>
      </div>
    </div>
  )
}
