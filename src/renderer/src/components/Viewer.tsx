import { DiffEditor, Editor } from '@monaco-editor/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitFileDiff, GitFileStat, GitStats } from '@shared/types'
import { editorFont, languageFor } from '../monaco'
import { api, useStore, type Panel } from '../store'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'
import { IconRefresh } from './icons'
import { Markdown } from './Markdown'

const nf = new Intl.NumberFormat('en-US')

const baseOptions = {
  ...editorFont,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: 'line' as const,
  contextmenu: false,
  overviewRulerBorder: false,
  padding: { top: 10, bottom: 10 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  stickyScroll: { enabled: false },
  // Colored brackets would break the one-color rule.
  bracketPairColorization: { enabled: false },
  guides: { bracketPairs: false },
  matchBrackets: 'never' as const
}

export interface ViewerFile {
  key: string
  name: string
  dir?: string
  status?: string
  nums?: string
}

/**
 * The one viewer used for git diffs, SKILL.md previews, MCP details and CLAUDE.md editing:
 * an optional file list on the left, a path bar, and a Monaco editor or diff editor.
 */
export function Viewer({
  files,
  active,
  onSelect,
  bar,
  diff,
  doc,
  rendered,
  empty
}: {
  files?: ViewerFile[]
  active?: string
  onSelect?: (key: string) => void
  bar?: ReactNode
  diff?: { original: string; modified: string; language: string; sideBySide: boolean }
  doc?: { content: string; language: string; readOnly: boolean; onChange?: (v: string) => void; onSave?: () => void }
  rendered?: string
  empty?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const onSaveRef = useRef(doc?.onSave)
  onSaveRef.current = doc?.onSave

  const move = (delta: number) => {
    if (!files?.length || !onSelect) return
    const idx = files.findIndex((f) => f.key === active)
    const next = files[Math.min(files.length - 1, Math.max(0, idx + delta))]
    if (next) onSelect(next.key)
  }

  return (
    <div className="viewer">
      {files && (
        <div
          className="viewer-files"
          ref={listRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              move(e.key === 'ArrowDown' ? 1 : -1)
            }
          }}
        >
          {files.map((f) => (
            <button key={f.key} className={`viewer-file${f.key === active ? ' is-active' : ''}`} onClick={() => onSelect?.(f.key)} title={f.dir ? `${f.dir}/${f.name}` : f.name}>
              {f.status && <span className="st">{f.status}</span>}
              <span className="name">
                {f.name}
                {f.dir && <span className="dir">{f.dir}</span>}
              </span>
              {f.nums && <span className="nums">{f.nums}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="viewer-main">
        {bar && <div className="viewer-bar">{bar}</div>}
        <div className="viewer-editor">
          {rendered !== undefined ? (
            <div className="transcript" style={{ height: '100%' }}>
              <Markdown text={rendered} />
            </div>
          ) : diff ? (
            <DiffEditor
              theme="symphony"
              original={diff.original}
              modified={diff.modified}
              language={diff.language}
              options={{
                ...baseOptions,
                readOnly: true,
                originalEditable: false,
                renderSideBySide: diff.sideBySide,
                // Keep the Side by side / Inline switch honest instead of letting Monaco flip it on narrow panels.
                useInlineViewWhenSpaceIsLimited: false,
                ignoreTrimWhitespace: false,
                renderOverviewRuler: true,
                hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
                renderIndicators: true,
                diffAlgorithm: 'advanced'
              }}
            />
          ) : doc ? (
            <Editor
              theme="symphony"
              value={doc.content}
              language={doc.language}
              onChange={(v) => doc.onChange?.(v ?? '')}
              onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.())
              }}
              options={{ ...baseOptions, readOnly: doc.readOnly, wordWrap: 'on', lineNumbers: 'on' }}
            />
          ) : (
            <div className="viewer-empty">{empty ?? ''}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function splitPath(p: string) {
  const parts = p.split('/')
  const name = parts.pop() ?? p
  return { name, dir: parts.join('/') }
}

// ---------- git diff ----------

export function DiffPanel({ panel }: { panel: Panel }) {
  const project = useStore((s) => s.projects[panel.targetId])
  const stats = useStore((s) => s.git[panel.targetId]) as GitStats | undefined
  const [active, setActive] = useState<string | undefined>()
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [sideBySide, setSideBySide] = useState(true)

  useEffect(() => {
    void api.gitStats(panel.targetId)
  }, [panel.targetId])

  const files = stats?.files ?? []
  const current = files.find((f) => f.path === active) ?? files[0]

  // Re-read the selected file whenever the project's stats change (the working tree moved).
  const load = useCallback(
    async (file: GitFileStat | undefined) => {
      if (!file) return setDiff(null)
      setDiff(await api.gitFileDiff(panel.targetId, file))
    },
    [panel.targetId]
  )
  useEffect(() => {
    void load(current)
  }, [current?.path, current?.added, current?.removed, current?.status, load])

  const list: ViewerFile[] = useMemo(
    () =>
      files.map((f) => {
        const { name, dir } = splitPath(f.path)
        return { key: f.path, name, dir, status: f.status, nums: f.binary ? 'bin' : `+${f.added} −${f.removed}` }
      }),
    [files]
  )

  if (!project) return null
  return (
    <FloatingPanel
      panel={panel}
      title={`${project.name} · changes`}
      meta={stats?.isRepo === false ? 'not a git repository' : `+${nf.format(stats?.added ?? 0)} −${nf.format(stats?.removed ?? 0)} · ${files.length} ${files.length === 1 ? 'file' : 'files'} · vs HEAD`}
      actions={
        <button className="icon-btn" title="Refresh" onClick={() => void api.gitStats(panel.targetId)}>
          <IconRefresh />
        </button>
      }
    >
      <Viewer
        files={list}
        active={current?.path}
        onSelect={setActive}
        bar={
          current && (
            <>
              <span className="path">{current.oldPath ? `${current.oldPath} → ${current.path}` : current.path}</span>
              <div className="seg">
                <button className={sideBySide ? 'is-on' : ''} onClick={() => setSideBySide(true)}>
                  Side by side
                </button>
                <button className={sideBySide ? '' : 'is-on'} onClick={() => setSideBySide(false)}>
                  Inline
                </button>
              </div>
            </>
          )
        }
        diff={diff && !diff.binary && current ? { original: diff.original, modified: diff.modified, language: languageFor(current.path), sideBySide } : undefined}
        empty={stats?.isRepo === false ? 'This folder is not a git repository.' : diff?.binary ? 'Binary file' : files.length ? '' : 'No uncommitted changes.'}
      />
    </FloatingPanel>
  )
}

// ---------- skill ----------

export function SkillPanel({ panel }: { panel: Panel }) {
  const skill = useStore((s) => s.skills.find((k) => k.id === panel.targetId))
  const [content, setContent] = useState<string | null>(null)
  const [mode, setMode] = useState<'source' | 'rendered'>('source')
  useEffect(() => {
    api
      .readSkill(panel.targetId)
      .then((r) => setContent(r.content))
      .catch(() => setContent(null))
  }, [panel.targetId, skill?.path])
  if (!skill) return null
  const body = content?.replace(/^---[\s\S]*?\n---\r?\n?/, '') ?? ''
  return (
    <FloatingPanel panel={panel} title={skill.name} meta={`${skill.scope} skill`}>
      <Viewer
        bar={
          <>
            <span className="path" title={skill.path}>
              {skill.path}
            </span>
            <div className="seg">
              <button className={mode === 'source' ? 'is-on' : ''} onClick={() => setMode('source')}>
                Source
              </button>
              <button className={mode === 'rendered' ? 'is-on' : ''} onClick={() => setMode('rendered')}>
                Rendered
              </button>
            </div>
          </>
        }
        doc={content !== null && mode === 'source' ? { content, language: languageFor(skill.path), readOnly: true } : undefined}
        rendered={content !== null && mode === 'rendered' ? body : undefined}
        empty={content === null ? 'Could not read this file.' : ''}
      />
    </FloatingPanel>
  )
}

// ---------- MCP server ----------

export function McpPanel({ panel }: { panel: Panel }) {
  const mcp = useStore((s) => s.mcp.find((m) => m.id === panel.targetId))
  if (!mcp) return null
  const statusOf = { connected: 'idle', pending: 'working', 'needs-auth': 'input', failed: 'idle', disabled: 'finished' } as const
  const details = JSON.stringify({ status: mcp.status, scope: mcp.scope, source: mcp.source, error: mcp.error, tools: mcp.tools, config: mcp.config }, null, 2)
  return (
    <FloatingPanel
      panel={panel}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <Glyph status={statusOf[mcp.status]} size={9} variant={mcp.status === 'failed' ? 'failed' : 'default'} />
          {mcp.name}
        </span>
      }
      meta={`${mcp.status}${mcp.scope ? ` · ${mcp.scope}` : ''}`}
      actions={
        <button className="icon-btn" title="Check again" onClick={() => void api.refreshConfig()}>
          <IconRefresh />
        </button>
      }
    >
      <Viewer bar={<span className="path">{mcp.tools.length} tools · secrets hidden</span>} doc={{ content: details, language: 'javascript', readOnly: true }} />
    </FloatingPanel>
  )
}

// ---------- CLAUDE.md ----------

export function ClaudeMdPanel({ panel }: { panel: Panel }) {
  const project = useStore((s) => s.projects[panel.targetId])
  const [file, setFile] = useState<{ path: string; content: string; exists: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void api.readClaudeMd(panel.targetId).then((f) => {
      setFile(f)
      setDraft(f.content)
    })
  }, [panel.targetId])
  const dirty = !!file && draft !== file.content
  const save = useCallback(async () => {
    if (!file) return
    setSaving(true)
    const path = await api.writeClaudeMd(panel.targetId, draft)
    setFile({ path, content: draft, exists: true })
    setSaving(false)
  }, [file, draft, panel.targetId])
  if (!project) return null
  return (
    <FloatingPanel
      panel={panel}
      title={`${project.name} · CLAUDE.md`}
      meta={file && !file.exists ? 'new file' : undefined}
      actions={
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()} title={`Save (${window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+S)`}>
          {dirty && <span className="dirty-dot" style={{ background: 'var(--bg)' }} />}
          Save
        </button>
      }
    >
      <Viewer
        bar={
          <span className="path" title={file?.path}>
            {file?.path}
          </span>
        }
        doc={file ? { content: draft, language: 'markdown', readOnly: false, onChange: setDraft, onSave: () => void save() } : undefined}
      />
    </FloatingPanel>
  )
}
