import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Note } from '@shared/types'
import { api, useLock } from '../store'
import { IconTrash } from './icons'
import { Markdown } from './Markdown'

const NOTE_SAVE_MS = 500

/** Markdown on a sticky note. Click to edit; leaving the editor shows it rendered again, and drops a note left empty. */
export function NoteCard({ note }: { note: Note }) {
  const lock = useLock()
  // A new note opens ready to type.
  const [editing, setEditing] = useState(!note.text && !lock)
  const [draft, setDraft] = useState(note.text)
  const area = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    const el = area.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, editing])

  useEffect(() => () => clearTimeout(timer.current), [])

  const finish = () => {
    clearTimeout(timer.current)
    setEditing(false)
    if (!draft.trim()) void api.noteDelete(note.id)
    else if (draft !== note.text) void api.noteUpdate(note.id, draft)
  }

  return (
    <div
      className={`note${editing ? ' is-editing' : ''}`}
      title={lock ?? undefined}
      onClick={(e) => {
        if (editing || lock || (e.target as Element).closest('a, button')) return
        setDraft(note.text)
        setEditing(true)
      }}
    >
      {editing ? (
        <textarea
          ref={area}
          value={draft}
          placeholder="Write in markdown"
          onChange={(e) => {
            const text = e.target.value
            setDraft(text)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => void api.noteUpdate(note.id, text), NOTE_SAVE_MS)
          }}
          onBlur={finish}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') area.current?.blur()
          }}
        />
      ) : note.text ? (
        <Markdown text={note.text} />
      ) : (
        <span className="note-empty">Empty note</span>
      )}
      <button
        className="icon-btn reveal"
        title="Delete note"
        disabled={!!lock}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          clearTimeout(timer.current)
          void api.noteDelete(note.id)
        }}
      >
        <IconTrash />
      </button>
    </div>
  )
}

/** The selected workspace's sticky notes, in a row above its sessions. */
export function NotesSection({ notes }: { notes: Note[] }) {
  if (!notes.length) return null
  return (
    <section className="notes" aria-label="Notes">
      {notes.map((n) => (
        <NoteCard key={n.id} note={n} />
      ))}
    </section>
  )
}

/** Notes keep a position for older versions of Symphony; the list does not use it. */
export function createNote(): void {
  void api.noteCreate({ x: 0, y: 0 })
}
