import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EFFORT_LABELS, type AskQuestion, type SessionInfo, type TranscriptItem } from '@shared/types'
import { api, useStore, type Panel } from '../store'
import { FloatingPanel } from './FloatingPanel'
import { Glyph, statusLabel } from './Glyph'
import { IconSend, IconStop, IconTrash } from './icons'
import { Markdown } from './Markdown'
import { usePastedImages } from '../images'
import { Attachments } from './Attachments'
import { useDictation } from '../speech/dictation'
import { DictationOverlay, DictationStatus, MicButton } from './Dictate'
import { useModelLabel } from './nodes'

const EMPTY: TranscriptItem[] = []

type Item<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>

function relPath(path: unknown, cwd: string): string {
  if (typeof path !== 'string') return ''
  const norm = (p: string) => p.replace(/\\/g, '/')
  const base = norm(cwd).replace(/\/$/, '') + '/'
  return norm(path).toLowerCase().startsWith(base.toLowerCase()) ? norm(path).slice(base.length) : norm(path)
}

/** One-line summary of what a tool call is acting on. */
function toolArg(name: string, input: Record<string, unknown>, cwd: string): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str('command').split('\n')[0]
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return relPath(input.file_path ?? input.notebook_path, cwd)
    case 'Glob':
    case 'Grep':
      return str('pattern')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    case 'Agent':
    case 'Task':
      return str('description')
    case 'Skill':
      return str('skill')
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : ''
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string')
      return typeof first === 'string' ? first.split('\n')[0] : ''
    }
  }
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function MiniDiff({ name, input, cwd }: { name: string; input: Record<string, unknown>; cwd: string }) {
  const lines: { t: 'add' | 'del'; s: string }[] = []
  const push = (t: 'add' | 'del', text: unknown) => {
    if (typeof text !== 'string') return
    for (const s of text.split('\n').slice(0, 400)) lines.push({ t, s })
  }
  if (name === 'Edit') {
    push('del', input.old_string)
    push('add', input.new_string)
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits as Record<string, unknown>[]) {
      push('del', e.old_string)
      push('add', e.new_string)
    }
  } else if (name === 'Write') {
    push('add', input.content)
  } else if (name === 'NotebookEdit') {
    push('add', input.new_source)
  }
  return (
    <div className="mini-diff">
      <div className="file">{relPath(input.file_path ?? input.notebook_path, cwd)}</div>
      {lines.map((l, i) => (
        <div key={i} className={`ln ${l.t}`}>
          {l.s || ' '}
        </div>
      ))}
    </div>
  )
}

function ToolCall({ item, cwd, hasChildren }: { item: Item<'tool'>; cwd: string; hasChildren: boolean }) {
  const [open, setOpen] = useState(false)
  const arg = toolArg(item.name, item.input, cwd)
  const state = item.result ? (item.result.isError ? 'error' : '') : hasChildren ? 'running' : '…'
  return (
    <div className="t-tool">
      <button className="t-tool-row" onClick={() => setOpen((o) => !o)}>
        <span className="t-tool-name">{item.name}</span>
        <span className="t-tool-arg" title={arg}>
          {arg}
        </span>
        <span className="t-tool-state">{state}</span>
      </button>
      {(open || (FILE_TOOLS.has(item.name) && !item.result?.isError)) && (
        <div className="t-tool-detail">
          {FILE_TOOLS.has(item.name) ? <MiniDiff name={item.name} input={item.input} cwd={cwd} /> : open && <pre className="code-block">{JSON.stringify(item.input, null, 2)}</pre>}
          {open && item.result && <pre className={`code-block${item.result.isError ? ' is-error' : ''}`}>{item.result.text || '(no output)'}</pre>}
        </div>
      )}
    </div>
  )
}

function Thinking({ item }: { item: Item<'thinking'> }) {
  const [expanded, setExpanded] = useState(false)
  const long = item.text.split('\n').length > 3 || item.text.length > 320
  const collapsed = !item.live && long && !expanded
  if (!item.text.trim() && !item.live) return null
  return (
    <div className={`t-thinking${collapsed ? ' is-collapsed' : ''}${item.live ? ' is-live' : ''}`} onClick={() => long && !item.live && setExpanded((e) => !e)}>
      {item.text || 'Thinking'}
    </div>
  )
}

/** Collapse whitespace so a one-line preview can be compared with the full command. */
const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

function Approval({ item, sessionId, cwd }: { item: Item<'approval'>; sessionId: string; cwd: string }) {
  const [reason, setReason] = useState('')
  const pending = !item.resolved
  const command = typeof item.input.command === 'string' ? item.input.command : null
  return (
    <div className={`t-request${pending ? '' : ' is-resolved'}`}>
      <div className="t-request-head">
        <Glyph status={pending ? 'approval' : 'finished'} size={10} />
        <span>{item.title ?? `Allow ${item.toolName}?`}</span>
      </div>
      {item.description && !(command && squash(command).startsWith(squash(item.description).replace(/…$/, ''))) && <div className="t-notice">{item.description}</div>}
      {command ? (
        <pre className="code-block">{command}</pre>
      ) : FILE_TOOLS.has(item.toolName) ? (
        <MiniDiff name={item.toolName} input={item.input} cwd={cwd} />
      ) : (
        <pre className="code-block">{JSON.stringify(item.input, null, 2)}</pre>
      )}
      {pending ? (
        <div className="t-request-actions">
          <button className="btn signal" onClick={() => void api.respondApproval(sessionId, item.id, 'allow')}>
            Allow
          </button>
          {item.canAlwaysAllow && (
            <button className="btn" onClick={() => void api.respondApproval(sessionId, item.id, 'always')}>
              Always allow
            </button>
          )}
          <input type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn" onClick={() => void api.respondApproval(sessionId, item.id, 'deny', reason)}>
            Deny
          </button>
        </div>
      ) : (
        <span className="resolution">
          {item.resolved === 'auto' ? 'auto-allowed' : item.resolved === 'always' ? 'always allowed' : item.resolved === 'allow' ? 'allowed' : 'denied'}
        </span>
      )}
    </div>
  )
}

function Question({ item, sessionId }: { item: Item<'question'>; sessionId: string }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const pending = !item.resolved
  const toggle = (q: AskQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? []
      return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] }
    })
  const answers = Object.fromEntries(
    item.questions.map((q) => {
      const chosen = [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])]
      return [q.question, chosen.join(', ')]
    })
  )
  const complete = item.questions.every((q) => answers[q.question])
  return (
    <div className={`t-request${pending ? '' : ' is-resolved'}`}>
      <div className="t-request-head">
        <Glyph status={pending ? 'input' : 'finished'} size={10} />
        <span>{item.questions.length > 1 ? 'Claude has questions' : 'Claude has a question'}</span>
      </div>
      {item.questions.map((q) => (
        <div key={q.question} className="q-block">
          <div className="q-text">{q.question}</div>
          {pending ? (
            <>
              {q.options.map((o) => (
                <button key={o.label} className={`q-option${picked[q.question]?.includes(o.label) ? ' is-picked' : ''}`} onClick={() => toggle(q, o.label)}>
                  <span className="mark" style={q.multiSelect ? undefined : { borderRadius: '50%' }} />
                  <span>
                    <span className="label">{o.label}</span>
                    {o.description && <span className="desc">{o.description}</span>}
                  </span>
                </button>
              ))}
              <div className="t-request-actions">
                <input
                  type="text"
                  placeholder="Something else"
                  value={other[q.question] ?? ''}
                  onChange={(e) => {
                    setOther((o) => ({ ...o, [q.question]: e.target.value }))
                    if (!q.multiSelect && e.target.value) setPicked((p) => ({ ...p, [q.question]: [] }))
                  }}
                />
              </div>
            </>
          ) : (
            <span className="resolution">{item.resolved?.[q.question] || 'no answer'}</span>
          )}
        </div>
      ))}
      {pending && (
        <div className="t-request-actions">
          <button className="btn signal" disabled={!complete} onClick={() => void api.respondQuestion(sessionId, item.id, answers)}>
            Answer
          </button>
        </div>
      )}
    </div>
  )
}

const Row = memo(function Row({ item, session, childParents }: { item: TranscriptItem; session: SessionInfo; childParents: Set<string> }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="t-user">
          {item.images && (
            <div className="t-user-images">
              {item.images.map((src, i) => (
                <img key={i} src={src} alt={`Attached image ${i + 1}`} />
              ))}
            </div>
          )}
          {item.text}
        </div>
      )
    case 'thinking':
      return <Thinking item={item} />
    case 'text':
      return item.text.trim() ? <Markdown text={item.text} /> : null
    case 'tool':
      return <ToolCall item={item} cwd={session.cwd} hasChildren={childParents.has(item.id)} />
    case 'approval':
      return <Approval item={item} sessionId={session.id} cwd={session.cwd} />
    case 'question':
      return <Question item={item} sessionId={session.id} />
    case 'result': {
      const secs = item.durationMs ? `${Math.round(item.durationMs / 1000)}s` : ''
      const cost = item.costUsd ? `$${item.costUsd.toFixed(2)}` : ''
      return (
        <>
          {item.isError && <div className="t-notice">{item.text}</div>}
          <div className="t-result">{[item.isError ? 'stopped' : 'done', secs, cost].filter(Boolean).join(' · ')}</div>
        </>
      )
    }
    case 'notice':
      return <div className="t-notice">{item.text}</div>
  }
})

function Transcript({ session, items, filter }: { session: SessionInfo; items: TranscriptItem[]; filter: (i: TranscriptItem) => boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const visible = useMemo(() => items.filter(filter), [items, filter])
  const childParents = useMemo(() => new Set(items.map((i) => ('parent' in i ? i.parent : null)).filter((p): p is string => !!p)), [items])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [visible])

  return (
    <div
      ref={ref}
      className="transcript"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {visible.map((item) => (
        <Row key={item.id} item={item} session={session} childParents={childParents} />
      ))}
      {!visible.length && <div className="t-notice">Starting…</div>}
    </div>
  )
}

function FilesChanged({ items, cwd }: { items: TranscriptItem[]; cwd: string }) {
  const files = useMemo(() => {
    const set = new Set<string>()
    for (const i of items) if (i.kind === 'tool' && FILE_TOOLS.has(i.name) && i.result && !i.result.isError) set.add(relPath(i.input.file_path ?? i.input.notebook_path, cwd))
    return [...set]
  }, [items, cwd])
  if (!files.length) return null
  return (
    <div className="files-changed" title="Files this session changed">
      {files.map((f) => (
        <span key={f}>{f}</span>
      ))}
    </div>
  )
}

function Reply({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('')
  const pasted = usePastedImages()
  const area = useRef<HTMLTextAreaElement>(null)
  const dictation = useDictation(text, setText, area)
  const dictating = dictation.state !== 'idle'
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  const canSend = (!!text.trim() || pasted.images.length > 0) && !dictating
  const send = () => {
    if (!canSend) return
    void api.sendMessage(sessionId, text, pasted.images)
    setText('')
    pasted.clear()
  }
  return (
    <div className="reply-wrap">
      <Attachments images={pasted.images} onRemove={pasted.remove} />
      <DictationStatus d={dictation} />
      <div className="reply">
        <div className="dictation-field">
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder="Reply to Claude"
            readOnly={dictating}
            className={dictating ? 'is-dictating' : undefined}
            onPaste={pasted.onPaste}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && dictation.state === 'recording') {
                e.preventDefault()
                dictation.cancel()
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <DictationOverlay d={dictation} area={area} />
        </div>
        <MicButton d={dictation} />
        <button className="icon-btn" title="Send" disabled={!canSend} onClick={send}>
          <IconSend />
        </button>
      </div>
    </div>
  )
}

function Identity({ session }: { session: SessionInfo }) {
  if (!session.identity) return null
  if (session.identity.login) return <span className="identity">@{session.identity.login}</span>
  return (
    <button
      className="identity is-none"
      title="This session has no GitHub account. Sign in for the next sessions."
      onClick={() => {
        useStore.getState().openPanel('login', 'github')
        void window.symphony.ghLogin()
      }}
    >
      no GitHub account
    </button>
  )
}

export function SessionPanel({ panel }: { panel: Panel }) {
  const session = useStore((s) => s.sessions[panel.targetId])
  const items = useStore((s) => s.transcripts[panel.targetId] ?? EMPTY)
  const model = useModelLabel(session?.model ?? '')
  const filter = useMemo(() => (i: TranscriptItem) => i.kind === 'approval' || i.kind === 'question' || !('parent' in i) || !i.parent, [])
  if (!session) return null
  const live = session.status !== 'finished' && session.status !== 'idle'
  return (
    <FloatingPanel
      panel={panel}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }} title={statusLabel(session.status)}>
          <Glyph status={session.status} size={10} />
          {session.kind === 'optimize' ? 'Optimizing prompt' : session.title.split('\n')[0]}
        </span>
      }
      meta={
        <>
          {model}
          {session.effort && ` · ${EFFORT_LABELS[session.effort].toLowerCase()}`} <Identity session={session} />
        </>
      }
      actions={
        live ? (
          <button className="icon-btn" title="Stop" onClick={() => void api.stopSession(session.id)}>
            <IconStop />
          </button>
        ) : (
          <button className="icon-btn" title="Remove session from the graph" onClick={() => void api.dismissSession(session.id)}>
            <IconTrash />
          </button>
        )
      }
    >
      <FilesChanged items={items} cwd={session.cwd} />
      <Transcript session={session} items={items} filter={filter} />
      <Reply sessionId={session.id} />
    </FloatingPanel>
  )
}

export function AgentPanel({ panel }: { panel: Panel }) {
  const liveAgent = useStore((s) => s.agents[panel.targetId])
  // The node disappears when the agent finishes; an open view keeps showing what it did.
  const last = useRef(liveAgent)
  if (liveAgent) last.current = liveAgent
  const agent = liveAgent ?? (last.current ? { ...last.current, status: 'finished' as const } : undefined)
  const session = useStore((s) => (agent ? s.sessions[agent.sessionId] : undefined))
  const items = useStore((s) => (agent ? (s.transcripts[agent.sessionId] ?? EMPTY) : EMPTY))
  const toolUseId = agent?.toolUseId
  const agentId = agent?.id
  const filter = useMemo(() => (i: TranscriptItem) => ('agentId' in i && i.agentId === agentId) || ('parent' in i && !!toolUseId && i.parent === toolUseId), [toolUseId, agentId])
  if (!agent || !session) return null
  return (
    <FloatingPanel
      panel={panel}
      title={
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }} title={statusLabel(agent.status)}>
          <Glyph status={agent.status} size={8} />
          {agent.description}
        </span>
      }
      meta={agent.subagentType}
    >
      <Transcript session={session} items={items} filter={filter} />
    </FloatingPanel>
  )
}
