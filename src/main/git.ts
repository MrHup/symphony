// Uncommitted changes for the diff viewer, split as VS Code's Git view does: staged (index vs HEAD)
// and unstaged (working tree vs index, untracked files included). Plus staging, branches and commits.
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitFileDiff, GitFileStat, GitStats } from '@shared/types'
import { gitPath, run } from './platform'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_TEXT_BYTES = 4 * 1024 * 1024

function git(cwd: string, args: string[], timeoutMs = 20_000) {
  return run(gitPath(), ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs })
}

/** Like git(), but a failure throws git's own message. */
async function gitOrThrow(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const res = await git(cwd, args, timeoutMs)
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `git ${args[0]} failed`)
  return res.stdout
}

async function baseRef(cwd: string): Promise<string> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return head.code === 0 ? 'HEAD' : EMPTY_TREE
}

/** The checked-out branch, or the short commit hash when HEAD is detached. */
async function currentBranch(cwd: string): Promise<string> {
  const name = (await git(cwd, ['branch', '--show-current'])).stdout.trim()
  return name || (await git(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
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

// --name-status -z: "M\0path\0" or "R100\0old\0new\0"
function parseNameStatus(out: string): Map<string, { status: GitFileStat['status']; oldPath?: string }> {
  const statusOf = new Map<string, { status: GitFileStat['status']; oldPath?: string }>()
  const ns = out.split('\0')
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
  return statusOf
}

// --numstat -z: "a\tr\tpath\0" or, for renames, "a\tr\t\0old\0new\0"
function parseNumstat(out: string): { path: string; added: number; removed: number; binary: boolean }[] {
  const files: { path: string; added: number; removed: number; binary: boolean }[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; ) {
    const rec = parts[i]
    if (!rec) {
      i++
      continue
    }
    const [a, r, p] = rec.split('\t')
    const rename = p === ''
    const binary = a === '-'
    files.push({ path: rename ? parts[i + 2] : p, added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary })
    i += rename ? 3 : 1
  }
  return files
}

/** Files changed in `git diff <range>`, under the project folder. */
async function diffFiles(cwd: string, range: string[]): Promise<GitFileStat[]> {
  const [numstat, nameStatus] = await Promise.all([
    git(cwd, ['diff', ...range, '--numstat', '-z', '-M', '--relative']),
    git(cwd, ['diff', ...range, '--name-status', '-z', '-M', '--relative'])
  ])
  const statusOf = parseNameStatus(nameStatus.stdout)
  return parseNumstat(numstat.stdout).map((f) => ({ ...f, ...(statusOf.get(f.path) ?? { status: 'M' as const }) }))
}

async function untrackedFiles(cwd: string): Promise<GitFileStat[]> {
  const paths = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)
  return Promise.all(
    paths.map(async (path) => {
      const { lines, binary } = await countLines(join(cwd, path))
      return { path, status: 'U' as const, added: lines, removed: 0, binary }
    })
  )
}

const byPath = (x: GitFileStat, y: GitFileStat) => x.path.localeCompare(y.path)

export async function getStats(cwd: string): Promise<GitStats> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false, added: 0, removed: 0, staged: [], unstaged: [] }

  const base = await baseRef(cwd)
  const [branch, vsHead, staged, unstaged, untracked] = await Promise.all([
    currentBranch(cwd),
    git(cwd, ['diff', base, '--numstat', '-z', '-M', '--relative']),
    diffFiles(cwd, ['--cached', base]),
    diffFiles(cwd, []),
    untrackedFiles(cwd)
  ])
  const total = [...parseNumstat(vsHead.stdout), ...untracked]
  return {
    isRepo: true,
    branch,
    added: total.reduce((n, f) => n + f.added, 0),
    removed: total.reduce((n, f) => n + f.removed, 0),
    staged: staged.sort(byPath),
    unstaged: [...unstaged, ...untracked].sort(byPath)
  }
}

/** A staged file compares HEAD with the index; an unstaged one, the index with the working tree. */
export async function getFileDiff(cwd: string, file: GitFileStat, staged: boolean): Promise<GitFileDiff> {
  if (file.binary) return { path: file.path, original: '', modified: '', binary: true }
  // rev '' is the index. Before the first commit there is no HEAD, so its side is empty.
  const show = async (rev: string, path: string) => {
    const shown = await git(cwd, ['show', `${rev}:./${path.replace(/\\/g, '/')}`])
    return shown.code === 0 ? shown.stdout : ''
  }
  const deleted = file.status === 'D'
  if (staged) {
    const [original, modified] = await Promise.all([file.status === 'A' ? '' : show('HEAD', file.oldPath ?? file.path), deleted ? '' : show('', file.path)])
    return { path: file.path, original, modified, binary: false }
  }
  const [original, modified] = await Promise.all([file.status === 'U' ? '' : show('', file.path), deleted ? '' : readFile(join(cwd, file.path), 'utf8').catch(() => '')])
  return { path: file.path, original, modified, binary: false }
}

/** Local branches, then remote ones without a local branch yet (switching to one creates it). */
export async function listBranches(cwd: string): Promise<string[]> {
  const refs = await gitOrThrow(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const names = refs
    .split('\n')
    .filter(Boolean)
    .map((ref) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.replace(/^refs\/remotes\/[^/]+\//, '')))
  return [...new Set(names)].filter((n) => n !== 'HEAD')
}

export async function switchBranch(cwd: string, branch: string): Promise<void> {
  if (branch.startsWith('-')) throw new Error('Not a branch name')
  await gitOrThrow(cwd, ['switch', branch])
}

/** Paths are relative to the project folder; '.' is all of it. */
export async function stage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await gitOrThrow(cwd, ['--literal-pathspecs', 'add', '-A', '--', ...paths])
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  // Before the first commit there is no HEAD to restore the index from.
  const cmd = (await baseRef(cwd)) === 'HEAD' ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q']
  await gitOrThrow(cwd, ['--literal-pathspecs', ...cmd, '--', ...paths])
}

export async function commitStaged(cwd: string, message: string): Promise<void> {
  if (!message.trim()) throw new Error('Write a commit message')
  // Hooks and signing can take a while.
  await gitOrThrow(cwd, ['commit', '-m', message.trim()], 120_000)
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
