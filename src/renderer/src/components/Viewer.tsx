import { DiffEditor, Editor } from '@monaco-editor/react'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { GitFileDiff, GitFileStat, GitStats } from '@shared/types'
import { editorFont, languageFor } from '../monaco'
import { api, useLock, useStore, type Panel } from '../store'
import { cleanError } from './Composer'
import { FloatingPanel } from './FloatingPanel'
import { Glyph } from './Glyph'
import { IconMinus, IconPlus, IconRefresh } from './icons'
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
  /** Files of one group follow each other under its heading in `groups`. */
  group?: string
  /** A button at the end of the row. */
  action?: ReactNode
}

/**
 * The one viewer used for git diffs, SKILL.md previews, MCP details and CLAUDE.md editing:
 * an optional file list on the left (with `side` above it), a path bar, and a Monaco editor or diff editor.
 */
export function Viewer({
  files,
  groups,
  side,
  active,
  onSelect,
  bar,
  diff,
  doc,
  rendered,
  empty
}: {
  files?: ViewerFile[]
  groups?: Record<string, ReactNode>
  side?: ReactNode
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
        <div className="viewer-side">
          {side}
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
            {files.map((f, i) => (
              <Fragment key={f.key}>
                {f.group !== undefined && f.group !== files[i - 1]?.group && <div className="viewer-group">{groups?.[f.group]}</div>}
                <div className={`viewer-row${f.key === active ? ' is-active' : ''}`}>
                  <button className="viewer-file" onClick={() => onSelect?.(f.key)} title={f.dir ? `${f.dir}/${f.name}` : f.name}>
                    {f.status && <span className="st">{f.status}</span>}
                    <span className="name">
                      {f.name}
                      {f.dir && <span className="dir">{f.dir}</span>}
                    </span>
                    {f.nums && <span className="nums">{f.nums}</span>}
                  </button>
                  {f.action}
                </div>
              </Fragment>
            ))}
          </div>
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

interface Change {
  key: string
  file: GitFileStat
  staged: boolean
}

/** A rename is staged or unstaged together with the path it came from. */
const pathsOf = (f: GitFileStat) => (f.oldPath ? [f.path, f.oldPath] : [f.path])

export function DiffPanel({ panel }: { panel: Panel }) {
  const project = useStore((s) => s.projects[panel.targetId])
  const stats = useStore((s) => s.git[panel.targetId]) as GitStats | undefined
  const lock = useLock(project?.machineId)
  const [active, setActive] = useState<{ path: string; staged: boolean }>()
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [sideBySide, setSideBySide] = useState(true)
  const [branches, setBranches] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.gitStats(panel.targetId).catch(() => undefined)
  }, [panel.targetId])

  useEffect(() => {
    api.gitBranches(panel.targetId).then(setBranches, () => setBranches([]))
  }, [panel.targetId, stats?.branch])

  /** Runs a git action; its error shows in the header until the next one. */
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  const commit = async () => {
    if (await run(() => api.gitCommit(panel.targetId, message))) setMessage('')
  }

  const staged = stats?.staged ?? []
  const unstaged = stats?.unstaged ?? []
  const changes: Change[] = [...staged.map((file) => ({ key: `staged:${file.path}`, file, staged: true })), ...unstaged.map((file) => ({ key: `unstaged:${file.path}`, file, staged: false }))]
  // A file just staged or unstaged stays selected in its new group.
  const current = changes.find((c) => c.file.path === active?.path && c.staged === active.staged) ?? changes.find((c) => c.file.path === active?.path) ?? changes[0]

  // Re-read the selected file whenever the project's stats change (the working tree moved).
  const load = useCallback(
    async (change: Change | undefined) => {
      if (!change) return setDiff(null)
      // An offline machine cannot send file contents; the list still shows its last known changes.
      setDiff(await api.gitFileDiff(panel.targetId, change.file, change.staged).catch(() => null))
    },
    [panel.targetId]
  )
  useEffect(() => {
    void load(current)
  }, [current?.key, current?.file.added, current?.file.removed, current?.file.status, load])

  const stageButton = (unstage: boolean, paths: string[], label: string) => (
    <button
      className="icon-btn"
      disabled={busy || !!lock}
      title={lock ?? label}
      onClick={() => void run(() => (unstage ? api.gitUnstage(panel.targetId, paths) : api.gitStage(panel.targetId, paths)))}
    >
      {unstage ? <IconMinus size={12} /> : <IconPlus size={12} />}
    </button>
  )
  const heading = (title: string, count: number, unstage: boolean) => (
    <>
      <span className="title">{title}</span>
      <span className="count">{count}</span>
      {stageButton(unstage, ['.'], unstage ? 'Unstage all' : 'Stage all')}
    </>
  )
  const list: ViewerFile[] = changes.map(({ key, file: f, staged: s }) => {
    const { name, dir } = splitPath(f.path)
    return { key, name, dir, status: f.status, nums: f.binary ? 'bin' : `+${f.added} −${f.removed}`, group: s ? 'staged' : 'unstaged', action: stageButton(s, pathsOf(f), s ? 'Unstage' : 'Stage') }
  })

  if (!project) return null
  const branch = stats?.branch
  // A detached HEAD shows its commit, which is not in the branch list.
  const choices = branch && !branches.includes(branch) ? [branch, ...branches] : branches
  const canCommit = !!message.trim() && staged.length > 0 && !busy && !lock
  return (
    <FloatingPanel
      panel={panel}
      machineId={project.machineId}
      title={`${project.name} · changes`}
      meta={error ?? (stats?.isRepo === false ? 'not a git repository' : `+${nf.format(stats?.added ?? 0)} −${nf.format(stats?.removed ?? 0)} vs HEAD · ${staged.length} staged · ${unstaged.length} unstaged`)}
      actions={
        <>
          {branch && (
            <select className="branch" value={branch} disabled={busy || !!lock} title={lock ?? 'Switch branch'} onChange={(e) => void run(() => api.gitSwitch(panel.targetId, e.target.value))}>
              {choices.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" title="Refresh" onClick={() => void api.gitStats(panel.targetId).catch(() => undefined)}>
            <IconRefresh />
          </button>
        </>
      }
    >
      <Viewer
        files={list}
        groups={{ staged: heading('Staged', staged.length, true), unstaged: heading('Changes', unstaged.length, false) }}
        side={
          stats?.isRepo && (
            <form
              className="commit"
              onSubmit={(e) => {
                e.preventDefault()
                if (canCommit) void commit()
              }}
            >
              <textarea
                value={message}
                rows={3}
                placeholder="Commit message"
                disabled={!!lock}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit()
                }}
              />
              <button className="btn primary" disabled={!canCommit} title={lock ?? (staged.length ? `Commit the staged changes (${window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter)` : 'Stage changes to commit them')}>
                Commit
              </button>
            </form>
          )
        }
        active={current?.key}
        onSelect={(key) => {
          const c = changes.find((x) => x.key === key)
          if (c) setActive({ path: c.file.path, staged: c.staged })
        }}
        bar={
          current && (
            <>
              <span className="path">
                {current.file.oldPath ? `${current.file.oldPath} → ${current.file.path}` : current.file.path}
                {current.staged ? ' · staged' : ''}
              </span>
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
        diff={diff && !diff.binary && current ? { original: diff.original, modified: diff.modified, language: languageFor(current.file.path), sideBySide } : undefined}
        empty={stats?.isRepo === false ? 'This folder is not a git repository.' : diff?.binary ? 'Binary file' : changes.length ? '' : 'No uncommitted changes.'}
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
    <FloatingPanel panel={panel} machineId={skill.machineId} title={skill.name} meta={`${skill.scope} skill`}>
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
  const lock = useLock(mcp?.machineId)
  if (!mcp) return null
  const statusOf = { connected: 'idle', pending: 'working', 'needs-auth': 'input', failed: 'idle', disabled: 'finished' } as const
  const details = JSON.stringify({ status: mcp.status, scope: mcp.scope, source: mcp.source, error: mcp.error, tools: mcp.tools, config: mcp.config }, null, 2)
  return (
    <FloatingPanel
      panel={panel}
      machineId={mcp.machineId}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          <Glyph status={statusOf[mcp.status]} size={9} variant={mcp.status === 'failed' ? 'failed' : 'default'} />
          {mcp.name}
        </span>
      }
      meta={`${mcp.status}${mcp.scope ? ` · ${mcp.scope}` : ''}`}
      actions={
        <button className="icon-btn" title="Check again" disabled={!!lock} onClick={() => void api.refreshConfig(mcp.machineId ?? 'local')}>
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
  const lock = useLock(project?.machineId)
  const [file, setFile] = useState<{ path: string; content: string; exists: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .readClaudeMd(panel.targetId)
      .then((f) => {
        setFile(f)
        setDraft(f.content)
      })
      .catch((err) => setError(cleanError(err)))
  }, [panel.targetId])
  const dirty = !!file && draft !== file.content
  const save = useCallback(async () => {
    if (!file || lock) return
    setSaving(true)
    setError(null)
    try {
      const path = await api.writeClaudeMd(panel.targetId, draft)
      setFile({ path, content: draft, exists: true })
    } catch (err) {
      // The draft stays in the editor, so nothing typed is lost.
      setError(cleanError(err))
    }
    setSaving(false)
  }, [file, draft, panel.targetId, lock])
  if (!project) return null
  return (
    <FloatingPanel
      panel={panel}
      machineId={project.machineId}
      title={`${project.name} · CLAUDE.md`}
      meta={error ?? (file && !file.exists ? 'new file' : undefined)}
      actions={
        <button className="btn primary" disabled={!dirty || saving || !!lock} onClick={() => void save()} title={lock ?? `Save (${window.symphony.platform === 'darwin' ? '⌘' : 'Ctrl'}+S)`}>
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
        doc={file ? { content: draft, language: 'markdown', readOnly: !!lock, onChange: setDraft, onSave: () => void save() } : undefined}
        empty={error ?? undefined}
      />
    </FloatingPanel>
  )
}
