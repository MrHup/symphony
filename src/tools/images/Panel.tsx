import { useRef, useState, type ReactNode } from 'react'
import type { ImageInput } from '@shared/types'
import { Attachments } from '../../renderer/src/components/Attachments'
import { cleanError } from '../../renderer/src/components/Composer'
import { FloatingPanel } from '../../renderer/src/components/FloatingPanel'
import { Markdown } from '../../renderer/src/components/Markdown'
import { MachineSelect, useMachineChoices } from '../../renderer/src/components/ToolMenu'
import { readImage } from '../../renderer/src/images'
import { useFileDrop } from '../../renderer/src/references'
import { useStore, type Panel } from '../../renderer/src/store'
import { call, downloadAll, EDGES, ImageCard, ImageViewer, useEntries, type ExportOptions } from './Gallery'
import guide from './README.md?raw'
import { ASPECTS, MAX_REFS, MODELS, modelInfo, TOOL_ID, type ImageKind, type ImageSize, type ImagesState, type KeyStatus, type RefRole } from './types'
import './panel.css'

const REF_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const KINDS: { id: ImageKind; name: string; title: string }[] = [
  { id: 'image', name: 'Image', title: 'Kept as generated' },
  { id: 'cutout', name: 'Cut-out', title: 'One subject, background made transparent, framed to fill the image' },
  { id: 'icon', name: 'Icon', title: 'A square cut-out, flat vector style unless references or a style say otherwise' }
]

/** Images across every machine: a Gemini key and a form for the machine you pick, and all images below. */
export function ImagesPanel({ panel }: { panel: Panel }) {
  const [reading, setReading] = useState(false)
  const [machineId, setMachineId] = useState<string | undefined>(undefined)
  const control = useStore((s) => s.control)
  const state = useStore((s) => (machineId ? s.machines[machineId]?.tools?.[TOOL_ID] : s.tools[TOOL_ID])) as ImagesState | undefined
  const machine = useMachineChoices().find((c) => c.machineId === machineId)
  // The picked machine can be unpaired while the panel is open.
  const lock = machine ? machine.lock : 'That machine is no longer paired'
  const key = state?.key ?? { source: null }

  return (
    <FloatingPanel
      panel={panel}
      title="Images"
      actions={
        <button className="btn ghost small" onClick={() => setReading(!reading)}>
          {reading ? 'Images' : 'How it works'}
        </button>
      }
    >
      <div className="loop-body img-tool">
        {reading ? (
          <Markdown text={guide} />
        ) : (
          <>
            <fieldset className="lock" disabled={!!control} title={control ? `Controlled by ${control.by}` : undefined}>
              <div className="loop-editor">
                <KeyBar machineId={machineId} status={key} name={machine?.name ?? 'that machine'} lock={lock} picker={<MachineSelect value={machineId} onChange={setMachineId} />} />
                {/* The picker stays usable when the picked machine is not, so another can be picked. */}
                <fieldset className="lock" disabled={!!lock} title={lock ?? undefined}>
                  {key.source ? <NewImages machineId={machineId} /> : <KeyForm machineId={machineId} name={machine?.name ?? 'that machine'} />}
                </fieldset>
              </div>
            </fieldset>
            <Gallery />
          </>
        )}
      </div>
    </FloatingPanel>
  )
}

// ---------- the Gemini key ----------

/** The machine picker, then where that machine's key comes from, with a way to replace or remove it. */
function KeyBar({ machineId, status, name, lock, picker }: { machineId?: string; status: KeyStatus; name: string; lock: string | null; picker: ReactNode }) {
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <div className="step-opts img-keybar">
        {picker}
        {status.source && (
          <fieldset className="lock step-opts" disabled={!!lock}>
            <span className="img-key" title={status.source === 'env' ? `From the ${status.env} environment variable on ${name}` : `Saved on ${name}, encrypted by the system keychain`}>
              Gemini key ····{status.hint} {status.source === 'env' ? `from ${status.env}` : 'saved in Symphony'}
            </span>
            {!changing && (
              <button className="btn ghost small" onClick={() => setChanging(true)}>
                {status.source === 'env' ? 'Use another key' : 'Change'}
              </button>
            )}
            {status.source === 'saved' && !changing && (
              <button className="btn ghost small" title="Forget the saved key" onClick={() => call('removeKey', [], machineId).then(() => setError(null), (err) => setError(cleanError(err)))}>
                Remove
              </button>
            )}
          </fieldset>
        )}
      </div>
      {error && <p className="loop-error">{error}</p>}
      {changing && status.source && (
        <fieldset className="lock" disabled={!!lock}>
          <KeyForm machineId={machineId} name={name} compact onDone={() => setChanging(false)} />
        </fieldset>
      )}
    </>
  )
}

/** Asks for a key; Gemini checks it before it is saved. */
function KeyForm({ machineId, name, compact, onDone }: { machineId?: string; name: string; compact?: boolean; onDone?: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('setKey', [value], machineId)
      setValue('')
      onDone?.()
    } catch (err) {
      setError(cleanError(err))
    }
    setBusy(false)
  }

  const field = (
    <div className="step-opts">
      <input
        className="img-key-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste a Gemini API key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save()}
      />
      <button className="btn primary" disabled={busy || !value.trim()} onClick={() => void save()}>
        {busy ? 'Checking…' : 'Save key'}
      </button>
      {onDone && (
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      )}
    </div>
  )
  if (compact)
    return (
      <>
        {field}
        {error && <p className="loop-error">{error}</p>}
      </>
    )
  return (
    <div className="img-key-form">
      <p className="loop-hint">
        Images are made with Google's Gemini image models and billed to your Google AI Studio account, not your Claude subscription. Get a key at{' '}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>
        .
      </p>
      {field}
      {error && <p className="loop-error">{error}</p>}
      <p className="loop-hint">Gemini checks the key before it is saved. It stays on {name}, encrypted by the system keychain, and is never shown again or sent to other machines.</p>
    </div>
  )
}

// ---------- a new batch ----------

function NewImages({ machineId }: { machineId?: string }) {
  const [prompts, setPrompts] = useState('')
  const [style, setStyle] = useState('')
  const [refs, setRefs] = useState<ImageInput[]>([])
  const [refRole, setRefRole] = useState<RefRole>('style')
  const [kind, setKind] = useState<ImageKind>('image')
  const [model, setModel] = useState(MODELS[1].id)
  const [size, setSize] = useState<ImageSize>('1K')
  const [aspect, setAspect] = useState('1:1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const info = modelInfo(model)!
  const lines = prompts
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const count = lines.length || (style.trim() || refs.length ? 1 : 0)
  const price = info.price[size]

  const addRefs = async (files: File[]) => {
    setError(null)
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length < files.length) setError('Only images can be references.')
    const read = await Promise.all(images.map((f) => readImage(f).catch(() => null)))
    const ok = read.filter((r): r is ImageInput => !!r && REF_TYPES.includes(r.mediaType))
    if (ok.length < images.length) setError('References must be PNG, JPG or WebP images.')
    setRefs((cur) => {
      const next = [...cur, ...ok]
      if (next.length > MAX_REFS) setError(`At most ${MAX_REFS} reference images; the rest were left out.`)
      return next.slice(0, MAX_REFS)
    })
  }
  const drop = useFileDrop(true, (files) => void addRefs(files))

  const pickModel = (id: string) => {
    const next = modelInfo(id)!
    setModel(id)
    if (!next.sizes.includes(size)) setSize(next.sizes.includes('1K') ? '1K' : next.sizes[0])
  }

  const generate = async () => {
    if (!count || busy) return
    setBusy(true)
    setError(null)
    try {
      await call('generate', [{ prompts: lines, style, kind, refRole, refs: refs.map((r) => ({ mediaType: r.mediaType, data: r.data })), model, size, aspect }], machineId)
      // References and the style often carry over to the next batch; the prompts were used.
      setPrompts('')
    } catch (err) {
      setError(cleanError(err))
    }
    setBusy(false)
  }

  return (
    <div className={`img-form${drop.over ? ' is-drop-over' : ''}`} {...drop.props}>
      <textarea
        className="step-prompt"
        rows={4}
        placeholder="One prompt per line, one image each. Paste or drop images to use them as references."
        value={prompts}
        onChange={(e) => setPrompts(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
          if (!files.length) return
          e.preventDefault()
          void addRefs(files)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void generate()}
      />
      <textarea
        className="step-prompt"
        rows={2}
        placeholder="Style, added to every prompt (optional). On its own, it makes one image."
        value={style}
        onChange={(e) => setStyle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void generate()}
      />
      <div className="img-refs">
        <Attachments images={refs} onRemove={(i) => setRefs((cur) => cur.filter((_, j) => j !== i))} />
        <button className="btn" disabled={refs.length >= MAX_REFS} onClick={() => fileInput.current?.click()}>
          {refs.length ? 'Add more' : 'Add reference images…'}
        </button>
        {refs.length > 0 && (
          <select className="model" value={refRole} onChange={(e) => setRefRole(e.target.value as RefRole)} title="What the reference images are for">
            <option value="style">Match their style</option>
            <option value="content">Use them as input</option>
          </select>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={REF_TYPES.join(',')}
          multiple
          hidden
          onChange={(e) => {
            void addRefs(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>
      <div className="step-opts">
        <select className="model" value={kind} onChange={(e) => setKind(e.target.value as ImageKind)} title={KINDS.find((k) => k.id === kind)?.title}>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id} title={k.title}>
              {k.name}
            </option>
          ))}
        </select>
        <select className="model" value={model} onChange={(e) => pickModel(e.target.value)} title="The Gemini model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select className="model" value={size} onChange={(e) => setSize(e.target.value as ImageSize)} title="Output size" disabled={info.sizes.length < 2}>
          {info.sizes.map((s) => (
            <option key={s} value={s}>
              {s === '512' ? '512 px' : s}
            </option>
          ))}
        </select>
        <select className="model" value={kind === 'icon' ? '1:1' : aspect} onChange={(e) => setAspect(e.target.value)} disabled={kind === 'icon'} title={kind === 'icon' ? 'Icons are square' : 'Aspect ratio'}>
          {ASPECTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="loop-error">{error}</p>}
      <div className="loop-foot">
        <span className="hint">
          {count
            ? `${info.name}, ${size === '512' ? '512 px' : size}${price ? `: about $${(count * price).toFixed(2)}` : ''}. Up to 4 are made at once.`
            : 'Write prompts, a style, or add reference images.'}
        </span>
        <kbd>{window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter</kbd>
        <button className="btn primary" disabled={!count || busy} onClick={() => void generate()}>
          {count > 1 ? `Generate ${count} images` : 'Generate'}
        </button>
      </div>
    </div>
  )
}

// ---------- every image ----------

function Gallery() {
  const entries = useEntries()
  const several = useMachineChoices().length > 1
  const [sticker, setSticker] = useState(false)
  const [edge, setEdge] = useState<number | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  const [zipping, setZipping] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const opts: ExportOptions = { edge, sticker }

  const ready = entries.filter((e) => e.item.file)
  const working = entries.filter((e) => e.item.status === 'queued' || e.item.status === 'working').length
  const failed = entries.filter((e) => e.item.status === 'error').length
  const anyCut = entries.some((e) => e.item.kind !== 'image')

  const clear = async () => {
    setConfirmClear(false)
    // Each machine deletes its own; a machine that cannot be reached right now keeps them.
    const byMachine = new Map<string | undefined, string[]>()
    for (const e of entries) if (!e.machine.lock) byMachine.set(e.machine.machineId, [...(byMachine.get(e.machine.machineId) ?? []), e.item.id])
    await Promise.all([...byMachine].map(([m, ids]) => call('delete', [ids], m))).then(
      () => setError(null),
      (err) => setError(cleanError(err))
    )
  }

  if (!entries.length) return <p className="loop-hint img-empty">Images you make appear here, from every machine.</p>

  return (
    <div className="img-gallery">
      <div className="img-toolbar">
        <span className="history-meta">
          {entries.length} {entries.length === 1 ? 'image' : 'images'}
          {working > 0 && ` · ${working} in progress`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
        <span className="spacer" />
        <label className="opt-toggle" title={anyCut ? 'Show and download cut-outs with a white die-cut border' : 'Only cut-outs and icons have a sticker version'}>
          <input type="checkbox" checked={sticker} disabled={!anyCut} onChange={(e) => setSticker(e.target.checked)} />
          Die-cut sticker
        </label>
        <select className="model" value={edge ?? ''} onChange={(e) => setEdge(e.target.value ? Number(e.target.value) : null)} title="Size of downloads (long edge)">
          {EDGES.map((n) => (
            <option key={n ?? 'full'} value={n ?? ''}>
              {n ? `${n} px` : 'Full size'}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!ready.length || zipping !== null}
          onClick={() => {
            setZipping(0)
            downloadAll(ready, opts, setZipping).then(
              () => setError(null),
              (err) => setError(cleanError(err))
            ).finally(() => setZipping(null))
          }}
        >
          {zipping !== null ? `Preparing ${zipping} of ${ready.length}…` : 'Download all'}
        </button>
        {confirmClear ? (
          <button className="btn" onClick={() => void clear()} onMouseLeave={() => setConfirmClear(false)}>
            Delete all {entries.length}
          </button>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmClear(true)}>
            Clear
          </button>
        )}
      </div>
      {error && <p className="loop-error">{error}</p>}
      <div className="img-grid">
        {entries.map((e) => (
          <ImageCard key={`${e.machine.machineId ?? 'local'}/${e.item.id}`} entry={e} opts={opts} showMachine={several} onOpen={() => setViewing(ready.indexOf(e))} />
        ))}
      </div>
      {viewing !== null && ready[viewing] && <ImageViewer entries={ready} index={viewing} opts={opts} onIndex={setViewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
