import { useEffect, useState } from 'react'
import type { EffortLevel } from '@shared/types'
import { cleanError, EffortSelect, ModelSelect } from '../../renderer/src/components/Composer'
import { FloatingPanel } from '../../renderer/src/components/FloatingPanel'
import { Glyph, statusLabel } from '../../renderer/src/components/Glyph'
import { IconTrash } from '../../renderer/src/components/icons'
import { Markdown } from '../../renderer/src/components/Markdown'
import { MachineSelect, useMachineChoices, type MachineChoice } from '../../renderer/src/components/ToolMenu'
import { api, clock, machineConfig, rollup, useStore, type Panel } from '../../renderer/src/store'
import guide from './README.md?raw'
import { TOOL_ID, type MobileUiState, type Preview, type Recipe } from './types'
import './panel.css'

const call = <T,>(method: string, args: unknown[], machineId?: string) => api.toolCall(TOOL_ID, method, args, machineId) as Promise<T>
const local = <T,>(method: string, args: unknown[]) => api.toolLocal(TOOL_ID, method, args) as Promise<T>

/** Every machine's recipes, newest first, each with the machine it lives on. */
function useRecipes(): { recipe: Recipe; machine: MachineChoice }[] {
  const choices = useMachineChoices()
  const here = useStore((s) => s.tools[TOOL_ID]) as MobileUiState | undefined
  const machines = useStore((s) => s.machines)
  const stateOf = (machineId?: string) => (machineId ? machines[machineId]?.tools?.[TOOL_ID] : here) as MobileUiState | undefined
  return choices.flatMap((c) => (stateOf(c.machineId)?.recipes ?? []).map((recipe) => ({ recipe, machine: c }))).sort((a, b) => b.recipe.createdAt - a.recipe.createdAt)
}

/** Mobile UI across every machine: all recipes, a form for a new one on the machine you pick, and the phone preview of each. */
export function MobileUiPanel({ panel }: { panel: Panel }) {
  const recipes = useRecipes()
  const several = useMachineChoices().length > 1
  const control = useStore((s) => s.control)
  const [adding, setAdding] = useState(false)
  const [reading, setReading] = useState(false)
  const [previews, setPreviews] = useState<Preview[]>([])
  useEffect(() => void local<Preview[]>('getPreviews', []).then(setPreviews, () => undefined), [])

  return (
    <FloatingPanel
      panel={panel}
      title="Mobile UI"
      actions={
        <button className="btn ghost small" onClick={() => setReading(!reading)}>
          {reading ? 'Recipes' : 'How it works'}
        </button>
      }
    >
      <div className="loop-body mui">
        {reading ? (
          <Markdown text={guide} />
        ) : (
          <>
            <fieldset className="lock" disabled={!!control} title={control ? `Controlled by ${control.by}` : undefined}>
              {adding || !recipes.length ? (
                <NewRecipe recipes={recipes.map((r) => r.recipe)} onClose={recipes.length ? () => setAdding(false) : undefined} />
              ) : (
                <button className="btn" onClick={() => setAdding(true)}>
                  + New recipe
                </button>
              )}
            </fieldset>
            {recipes.map(({ recipe: r, machine }) => (
              <RecipeCard
                key={`${machine.machineId ?? 'local'}/${r.id}`}
                recipe={r}
                machine={machine}
                showMachine={several}
                preview={previews.find((p) => p.recipeId === r.id && p.machineId === machine.machineId)}
                setPreview={(p) => setPreviews((list) => [...list.filter((x) => !(x.recipeId === r.id && x.machineId === machine.machineId)), ...(p ? [p] : [])])}
              />
            ))}
          </>
        )}
      </div>
    </FloatingPanel>
  )
}

function NewRecipe({ recipes, onClose }: { recipes: Recipe[]; onClose?: () => void }) {
  const [machineId, setMachineId] = useState<string | undefined>(undefined)
  const machine = useMachineChoices().find((c) => c.machineId === machineId)
  const all = useStore((s) => s.projects)
  const projects = Object.values(all).filter((p) => p.machineId === machineId && !recipes.some((r) => r.projectId === p.id))
  const config = machineConfig(useStore.getState(), machineId)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState('')
  const [model, setModel] = useState(config.defaultModel)
  const [effort, setEffort] = useState<EffortLevel | ''>(config.efforts[config.defaultModel] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The picked machine can be unpaired while the form is open.
  const lock = machine ? machine.lock : 'That machine is no longer paired'

  // Models, efforts and projects are each machine's own, so picking another machine starts them over.
  const pickMachine = (id?: string) => {
    const next = machineConfig(useStore.getState(), id)
    setMachineId(id)
    setSource('')
    setModel(next.defaultModel)
    setEffort(next.efforts[next.defaultModel] ?? '')
  }

  const create = async () => {
    if (lock) return
    setBusy(true)
    setError(null)
    try {
      const r = await call<Recipe>('create', [{ name, prompt, sourceProjectId: source || undefined, model, effort: effort || undefined }], machineId)
      useStore.getState().openPanel('session', r.sessions[0].id)
      onClose?.()
    } catch (err) {
      setError(cleanError(err))
    }
    setBusy(false)
  }

  return (
    <div className="loop-editor">
      <input className="loop-name" placeholder="Recipe name, e.g. Habit tracker" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        className="step-prompt"
        rows={5}
        placeholder="What should the app be, or what should change in yours? Screens, flows, style, animations…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && prompt.trim() && void create()}
      />
      <div className="step-opts">
        <MachineSelect value={machineId} onChange={pickMachine} />
        <select className="model mui-source" value={source} onChange={(e) => setSource(e.target.value)} title="An existing app to build the recipe from">
          <option value="">From the prompt only</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              From {p.name}
            </option>
          ))}
        </select>
        {machineId ? (
          <button className="btn" disabled={!!lock} title="Add a project from the folders that machine shares" onClick={() => useStore.getState().openPanel('folders', machineId)}>
            Add a folder…
          </button>
        ) : (
          <button className="btn" title="Add a folder as a project and build from it" onClick={() => void api.addProject().then((p) => p && setSource(p.id))}>
            Add a folder…
          </button>
        )}
      </div>
      <div className="step-opts">
        <span className="spacer" />
        <ModelSelect machineId={machineId} value={model} onChange={(m) => (setModel(m), setEffort(config.efforts[m] ?? ''))} />
        <EffortSelect machineId={machineId} model={model} value={effort} onChange={setEffort} />
      </div>
      {error && <p className="loop-error">{error}</p>}
      <div className="loop-foot">
        <span className="hint">
          {lock && machineId ? lock : `Claude builds the app and its documentation in a session on ${machine?.name ?? 'that machine'}; the source folder is only read.`}
        </span>
        {onClose && (
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={busy || !prompt.trim() || !!lock} onClick={() => void create()}>
          Create recipe
        </button>
      </div>
    </div>
  )
}

function RecipeCard({
  recipe: r,
  machine,
  showMachine,
  preview,
  setPreview
}: {
  recipe: Recipe
  machine: MachineChoice
  showMachine: boolean
  preview?: Preview
  setPreview: (p: Preview | null) => void
}) {
  const { machineId, lock } = machine
  const [doc, setDoc] = useState<string | null | undefined>(undefined)
  const [showDoc, setShowDoc] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = rollup(r.sessions.map((s) => s.status))
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (err) => setError(cleanError(err)))

  const toggleDoc = () => {
    setShowDoc(!showDoc)
    if (!showDoc) run(call<string | null>('getDoc', [r.id], machineId).then(setDoc))
  }

  return (
    <div className="step-card mui-recipe">
      <div className="step-head">
        <Glyph status={status} size={12} />
        <span className="loop-card-text mui-name">{r.name}</span>
        <span className="history-meta">
          {showMachine && `${machine.name}${machine.offline ? ' (offline)' : ''} · `}
          {clock(r.createdAt)}
        </span>
        <fieldset className="lock mui-actions" disabled={!!lock} title={lock ?? undefined}>
          {preview ? (
            <button className="btn" onClick={() => run(local('stop', [machineId ?? null, r.id]).then(() => setPreview(null)))}>
              Stop preview
            </button>
          ) : (
            <button className="btn" onClick={() => run(local<Preview>('start', [machineId ?? null, r.id]).then(setPreview))}>
              Preview on phone
            </button>
          )}
          <button className="btn ghost" onClick={toggleDoc}>
            {showDoc ? 'Hide docs' : 'Docs'}
          </button>
          {confirm ? (
            <button className="btn" onClick={() => run(call('delete', [r.id], machineId))}>
              Delete it and its folder
            </button>
          ) : (
            <button className="icon-btn" title="Delete the recipe" onClick={() => setConfirm(true)}>
              <IconTrash />
            </button>
          )}
        </fieldset>
      </div>
      <p className="mui-prompt">{r.prompt}</p>
      {r.source && <p className="mui-path">from {r.source}</p>}
      <p className="mui-path" title={r.dir}>
        {r.dir}
      </p>
      {preview && <PhonePreview preview={preview} />}
      {r.sessions.slice(0, 3).map((s) => (
        <button key={s.id} className="artifact" onClick={() => useStore.getState().openPanel('session', s.id)}>
          <span className="artifact-label">{s.title}</span>
          <span className="artifact-target">{statusLabel(s.status)}</span>
        </button>
      ))}
      {showDoc && <div className="mui-doc">{doc === undefined ? <p className="loop-hint">Loading…</p> : doc ? <Markdown text={doc} /> : <p className="loop-hint">No docs/RECIPE.md yet.</p>}</div>}
      {error && <p className="loop-error">{error}</p>}
    </div>
  )
}

function PhonePreview({ preview }: { preview: Preview }) {
  const [url, ...others] = preview.urls
  return (
    <div className="mui-preview">
      <img className="mui-qr" alt="QR code of the preview link" src={`data:image/svg+xml;utf8,${encodeURIComponent(preview.qr)}`} />
      <div className="mui-preview-text">
        <p>Scan it with a phone on this network. Anyone with the link can comment, so share it only with people you trust; Stop preview ends it.</p>
        <button className="btn ghost small mui-url" title="Copy the link" onClick={() => void navigator.clipboard.writeText(url)}>
          {url}
        </button>
        {others.length > 0 && <p className="mui-path">Also: {others.join(', ')}</p>}
        <details>
          <summary>First time on this phone</summary>
          <p>
            Open the link and accept the certificate warning. Tap <em>this certificate</em> in the preview, then trust it: on iPhone install it under Settings › General › VPN &amp; Device
            Management and turn it on under Settings › General › About › Certificate Trust Settings; on Android install it under Settings › Security › Encryption &amp; credentials ›
            Install a certificate › CA certificate. Then add the preview to the home screen to open it full screen, like an installed app.
          </p>
        </details>
      </div>
    </div>
  )
}
