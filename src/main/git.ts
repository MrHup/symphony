// Uncommitted-change stats and file contents for the diff viewer. Compares the working tree
// (including untracked files) with HEAD, which is what VS Code's Git view shows as "Changes".
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitFileDiff, GitFileStat, GitStats } from '@shared/types'
import { gitPath, run } from './platform'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_TEXT_BYTES = 4 * 1024 * 1024

function git(cwd: string, args: string[], timeoutMs = 20_000) {
  return run(gitPath(), ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs })
}

async function baseRef(cwd: string): Promise<string> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.code === 0 ? 'HEAD' : EMPTY_TREE
}

async function looksBinary(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(8000)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fh.close()
  }
}

async function countLines(path: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { lines: 0, binary: false }
    if (info.size > MAX_TEXT_BYTES || (await looksBinary(path))) return { lines: 0, binary: true }
    const text = await readFile(path, 'utf8')
    if (!text) return { lines: 0, binary: false }
    const newlines = text.split('\n').length - 1
    return { lines: text.endsWith('\n') ? newlines : newlines + 1, binary: false }
  } catch {
    return { lines: 0, binary: false }
  }
}

export async function getStats(cwd: string): Promise<GitStats> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false, added: 0, removed: 0, files: [] }

  const base = await baseRef(cwd)
  const [numstat, nameStatus, untracked] = await Promise.all([
    git(cwd, ['diff', base, '--numstat', '-z', '-M', '--relative']),
    git(cwd, ['diff', base, '--name-status', '-z', '-M', '--relative']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])

  // --name-status -z: "M\0path\0" or "R100\0old\0new\0"
  const statusOf = new Map<string, { status: GitFileStat['status']; oldPath?: string }>()
  const ns = nameStatus.stdout.split('\0')
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i]
    if (!code) break
    if (code.startsWith('R') || code.startsWith('C')) {
      statusOf.set(ns[i + 2], { status: 'R', oldPath: ns[i + 1] })
      i += 3
    } else {
      const s = code.charAt(0)
      statusOf.set(ns[i + 1], { status: s === 'A' || s === 'D' ? s : 'M' })
      i += 2
    }
  }

  // --numstat -z: "a\tr\tpath\0" or, for renames, "a\tr\t\0old\0new\0"
  const files: GitFileStat[] = []
  const parts = numstat.stdout.split('\0')
  for (let i = 0; i < parts.length; ) {
    const rec = parts[i]
    if (!rec) {
      i++
      continue
    }
    const [a, r, p] = rec.split('\t')
    let path = p
    let step = 1
    if (p === '') {
      path = parts[i + 2]
      step = 3
    }
    const binary = a === '-'
    const meta = statusOf.get(path) ?? { status: 'M' as const }
    files.push({ path, oldPath: meta.oldPath, status: meta.status, added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary })
    i += step
  }

  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean)
  const counted = await Promise.all(untrackedPaths.map((p) => countLines(join(cwd, p))))
  untrackedPaths.forEach((path, idx) => {
    files.push({ path, status: 'U', added: counted[idx].lines, removed: 0, binary: counted[idx].binary })
  })

  files.sort((x, y) => x.path.localeCompare(y.path))
  return {
    isRepo: true,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    files
  }
}

export async function getFileDiff(cwd: string, file: GitFileStat): Promise<GitFileDiff> {
  if (file.binary) return { path: file.path, original: '', modified: '', binary: true }
  const base = await baseRef(cwd)
  let original = ''
  if (base === 'HEAD' && file.status !== 'A' && file.status !== 'U') {
    const shown = await git(cwd, ['show', `HEAD:./${(file.oldPath ?? file.path).replace(/\\/g, '/')}`])
    original = shown.code === 0 ? shown.stdout : ''
  }
  let modified = ''
  if (file.status !== 'D') {
    try {
      modified = await readFile(join(cwd, file.path), 'utf8')
    } catch {
      modified = ''
    }
  }
  return { path: file.path, original, modified, binary: false }
}

/** "owner/repo" host of the origin remote, used to decide which gh account applies. */
export async function remoteHost(cwd: string): Promise<string> {
  const res = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = res.stdout.trim()
  const https = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)/)
  if (https) return https[1]
  const ssh = url.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)/)
  if (ssh) return ssh[1]
  return 'github.com'
}
