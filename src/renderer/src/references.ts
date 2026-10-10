// Reference files: dropped onto a project (its node, its prompt bubble or a session's reply box),
// saved in the project's .claude-references folder, and mentioned in prompts as
// @.claude-references/<name>. The contents travel in the request, so a remote project works the same.
import { useCallback, useEffect, useState } from 'react'
import { MAX_FILE_BYTES } from '@shared/remote'
import type { ReferenceFile } from '@shared/types'
import { cleanError } from './components/Composer'
import { base64 } from './images'
import { api } from './store'

export const mention = (r: ReferenceFile) => `@${r.path}`

/** Files (not folders) in a drop. Read during the drop event: the items are gone afterwards. */
export function droppedFiles(dt: DataTransfer): File[] {
  return Array.from(dt.items)
    .filter((i) => i.kind === 'file' && !i.webkitGetAsEntry()?.isDirectory)
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
}

/** Saves files into a project's reference folder, one request each, so each fits the remote link on its own. */
export async function uploadReferences(projectId: string, files: File[]): Promise<{ added: ReferenceFile[]; errors: string[] }> {
  const added: ReferenceFile[] = []
  const errors: string[] = []
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      errors.push(`${f.name} is too large (the limit is 20 MB).`)
      continue
    }
    try {
      added.push(await api.referenceAdd(projectId, f.name, await base64(f)))
    } catch (err) {
      errors.push(`${f.name}: ${cleanError(err)}`)
    }
  }
  return { added, errors }
}

/** A project's reference files, with adding and deleting. Without a project (a session outside one), none. */
export function useReferences(projectId: string | null | undefined) {
  const [files, setFiles] = useState<ReferenceFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!projectId) return setFiles([])
    api.referenceList(projectId).then(setFiles, () => setFiles([]))
  }, [projectId])

  useEffect(() => {
    setError(null)
    refresh()
  }, [refresh])

  const add = useCallback(
    async (dropped: File[]): Promise<ReferenceFile[]> => {
      if (!projectId || !dropped.length) return []
      setBusy(true)
      setError(null)
      const { added, errors } = await uploadReferences(projectId, dropped)
      setBusy(false)
      if (errors.length) setError(errors.join(' '))
      refresh()
      return added
    },
    [projectId, refresh]
  )

  const remove = useCallback(
    (name: string) => {
      if (!projectId) return
      setError(null)
      api.referenceDelete(projectId, name).then(refresh, (err) => setError(cleanError(err)))
    },
    [projectId, refresh]
  )

  return { files, busy, error, add, remove }
}

/**
 * Drag-and-drop handlers for an element that takes files. Drops of folders only are left alone, so
 * the window still adds a dropped folder as a project. The window's own drop handler skips drops
 * these handlers took (they call preventDefault).
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  const props = {
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      setOver(false)
      if (!enabled) return
      const files = droppedFiles(e.dataTransfer)
      if (!files.length) return
      e.preventDefault()
      onFiles(files)
    }
  }
  return { over, props }
}

/** Puts mentions at the cursor (the end, when the box is not focused), spaced from the words around them. */
export function insertMentions(area: HTMLTextAreaElement | null, setText: React.Dispatch<React.SetStateAction<string>>, refs: ReferenceFile[]): void {
  if (!refs.length) return
  const focused = !!area && document.activeElement === area
  let caret = -1
  // From the latest text: an upload can finish after more was typed.
  setText((text) => {
    const at = focused ? area!.selectionStart : text.length
    const before = text.slice(0, at)
    const after = text.slice(at)
    const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${refs.map(mention).join(' ')}${/^\s/.test(after) ? '' : ' '}`
    caret = before.length + insert.length
    return before + insert + after
  })
  requestAnimationFrame(() => {
    if (!area || caret < 0) return
    area.focus()
    area.setSelectionRange(caret, caret)
  })
}
