// Reference files: images and documents the user drops onto a project, kept in its
// .claude-references folder so prompts can point at them (`@.claude-references/mockup.png`). The
// contents arrive in the request rather than as a path, so a remote machine's project gets them the
// same way as one on this machine.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { MAX_FILE_BYTES } from '@shared/remote'
import type { ReferenceFile } from '@shared/types'

export const REFERENCES_DIR = '.claude-references'

/** Appended to Claude Code's system prompt, next to the show_files note. */
export const REFERENCES_PROMPT = `# Reference files
The user can add files for you to work from (designs, screenshots, documents) to the ${REFERENCES_DIR} folder of the project. A path such as @${REFERENCES_DIR}/mockup.png in a message points at one of them: read it before you start the work it belongs to. Do not edit, move or delete these files unless the user asks.`

/** Keeps the folder out of git, so references never show up as changes or get committed by accident. */
const GITIGNORE = '.gitignore'

/**
 * A name that is safe as a file name on every platform and as an @-mention (no spaces or quotes):
 * letters, digits, dot, dash and underscore. Never a path.
 */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const ext = extname(base).toLowerCase().replace(/[^.\p{L}\p{N}]/gu, '')
  const stem = base
    .slice(0, base.length - extname(base).length)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return `${stem || 'file'}${ext}`
}

function toRef(name: string, size: number, modified: number): ReferenceFile {
  return { name, path: `${REFERENCES_DIR}/${name}`, size, modified }
}

/** The project's reference files, newest first. */
export async function listReferences(cwd: string): Promise<ReferenceFile[]> {
  const dir = join(cwd, REFERENCES_DIR)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name !== GITIGNORE)
      .map(async (e) => {
        const info = await stat(join(dir, e.name))
        return toRef(e.name, info.size, info.mtimeMs)
      })
  )
  return files.sort((a, b) => b.modified - a.modified)
}

/**
 * Saves a file (base64 contents) into the project's reference folder. A file already there with the
 * same name and content is reused; a different one with that name gets a numbered name instead.
 */
export async function addReference(cwd: string, name: string, data: string): Promise<ReferenceFile> {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is too large (${Math.round(bytes.length / 1024 / 1024)} MB; the limit is 20 MB).`)
  const dir = join(cwd, REFERENCES_DIR)
  await mkdir(dir, { recursive: true })
  if (!existsSync(join(dir, GITIGNORE))) await writeFile(join(dir, GITIGNORE), '# Files added in Symphony for prompts to refer to.\n*\n')
  const clean = safeName(name)
  const ext = extname(clean)
  const stem = clean.slice(0, clean.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? clean : `${stem}-${n}${ext}`
    const path = join(dir, candidate)
    const existing = await readFile(path).catch(() => null)
    if (existing && !existing.equals(bytes)) continue
    if (!existing) await writeFile(path, bytes, { flag: 'wx' })
    const info = await stat(path)
    return toRef(candidate, info.size, info.mtimeMs)
  }
}

export async function removeReference(cwd: string, name: string): Promise<void> {
  if (name !== safeName(name) || name === GITIGNORE) throw new Error('Not a reference file.')
  await rm(join(cwd, REFERENCES_DIR, name), { force: true })
}
