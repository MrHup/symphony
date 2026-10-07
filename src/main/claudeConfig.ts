// Discovers skills, MCP servers and CLAUDE.md files the way Claude Code sees them.
//
// The authoritative lists come from the CLI itself: an "inspector" query starts Claude Code in a
// folder, reads its initialization result and MCP status, and closes without sending a prompt, so
// it costs no tokens. The filesystem scan only supplies the SKILL.md paths for previewing/editing.
import { query, type McpServerStatus, type ModelInfo, type Query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { McpInfo, SkillInfo, UsageInfo, UsageWindow } from '@shared/types'
import { claudeDir, claudeExecutable } from './platform'
import { subscriptionEnv, subscriptionSettings } from './subscription'

export interface InspectResult {
  commands: SlashCommand[]
  mcp: McpServerStatus[]
  models: ModelInfo[]
}

/** Start Claude Code in `cwd` without sending a prompt (so no tokens are spent), run `read` against it, then close it. */
async function withIdleQuery<T>(cwd: string, read: (q: Query) => Promise<T>): Promise<T> {
  let release!: () => void
  const hold = new Promise<void>((r) => (release = r))
  async function* idle() {
    await hold
  }
  const q = query({
    prompt: idle(),
    options: {
      cwd,
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: claudeExecutable(),
      persistSession: false,
      env: subscriptionEnv(process.env),
      settings: subscriptionSettings
    }
  })
  // Drain the stream so the transport keeps flowing; nothing is sent, so nothing meaningful arrives.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        // ignore
      }
    } catch {
      // closed
    }
  })()
  try {
    await q.initializationResult()
    return await read(q)
  } finally {
    release()
    q.close()
    await drain
  }
}

/** What Claude Code loaded in `cwd`: commands (skills), models and MCP server status. */
export function inspect(cwd: string, timeoutMs = 25_000): Promise<InspectResult> {
  return withIdleQuery(cwd, async (q) => {
    const init = await q.initializationResult()
    const deadline = Date.now() + timeoutMs
    let mcp = await q.mcpServerStatus()
    while (mcp.some((s) => s.status === 'pending') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750))
      mcp = await q.mcpServerStatus()
    }
    return { commands: init.commands, mcp, models: init.models }
  })
}

// ---------- plan usage ----------

type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined

/**
 * Plan usage windows (5-hour, weekly, weekly per model) as the CLI's /usage dialog shows them.
 * The SDK exposes this through an experimental control call; if a later SDK renames or drops it,
 * this is the only place that needs to change.
 */
export async function readUsage(cwd: string): Promise<UsageInfo> {
  try {
    return await withIdleQuery(cwd, async (q) => {
      const call = (q as Partial<Query>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof call !== 'function') throw new Error('This Agent SDK version does not report plan usage.')
      const u = await call.call(q, { skipBehaviors: true })
      const limits = u.rate_limits
      const windows: UsageWindow[] = []
      const add = (id: string, label: string, w: RawWindow) => {
        if (w && w.utilization !== null) windows.push({ id, label, percent: w.utilization, resetsAt: w.resets_at })
      }
      add('five_hour', 'Current 5-hour session', limits?.five_hour)
      add('seven_day', 'This week, all models', limits?.seven_day)
      for (const m of limits?.model_scoped ?? []) add(`model:${m.display_name}`, `This week, ${m.display_name}`, m)
      return { available: u.rate_limits_available, plan: u.subscription_type, windows, fetchedAt: Date.now() }
    })
  } catch (err) {
    return { available: false, plan: null, windows: [], fetchedAt: Date.now(), error: (err as Error).message }
  }
}

// ---------- skills ----------

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim()
    } else if (/^["'].*["']$/.test(value)) {
      value = value.slice(1, -1)
    }
    out[kv[1]] = value
  }
  return out
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

async function skillsIn(dir: string, scope: SkillInfo['scope'], prefix = '', projectId?: string): Promise<SkillInfo[]> {
  const found: SkillInfo[] = []
  for (const sub of await subdirs(dir)) {
    const file = join(sub, 'SKILL.md')
    if (!existsSync(file)) continue
    const fm = frontmatter(await readFile(file, 'utf8').catch(() => ''))
    const name = prefix + (fm.name || basename(sub))
    found.push({ id: `skill:${scope}:${projectId ?? ''}:${name}`, name, description: fm.description ?? '', path: file, scope, projectId })
  }
  // Legacy .claude/commands/*.md still define slash commands.
  const commandsDir = join(dirname(dir), 'commands')
  if (scope !== 'plugin' && scope !== 'synced' && existsSync(commandsDir)) {
    for (const entry of await readdir(commandsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const file = join(commandsDir, entry.name)
      const fm = frontmatter(await readFile(file, 'utf8').catch(() => ''))
      const name = prefix + entry.name.replace(/\.md$/, '')
      found.push({ id: `skill:${scope}:${projectId ?? ''}:${name}`, name, description: fm.description ?? '', path: file, scope, projectId })
    }
  }
  return found
}

async function pluginSkills(): Promise<SkillInfo[]> {
  const registry = join(claudeDir, 'plugins', 'installed_plugins.json')
  const found: SkillInfo[] = []
  try {
    const parsed = JSON.parse(await readFile(registry, 'utf8')) as { plugins?: Record<string, { installPath: string }[]> }
    for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
      const plugin = key.split('@')[0]
      const install = installs[installs.length - 1]
      if (!install?.installPath) continue
      found.push(...(await skillsIn(join(install.installPath, 'skills'), 'plugin', `${plugin}:`)))
    }
  } catch {
    // no plugins
  }
  return found
}

/** User, synced (claude.ai) and plugin skills. Filtered to what the CLI reports as loaded when `loaded` is given. */
export async function userSkills(loaded?: Set<string>): Promise<SkillInfo[]> {
  const skillsRoot = join(claudeDir, 'skills')
  const synced: SkillInfo[] = []
  for (const bucket of await subdirs(join(skillsRoot, 'synced'))) synced.push(...(await skillsIn(bucket, 'synced')))
  const all = [...(await skillsIn(skillsRoot, 'user')), ...synced, ...(await pluginSkills())]
  const unique = new Map<string, SkillInfo>()
  for (const s of all) if (!unique.has(s.name) && (!loaded || loaded.has(s.name))) unique.set(s.name, s)
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function projectSkills(projectId: string, projectPath: string): Promise<SkillInfo[]> {
  return (await skillsIn(join(projectPath, '.claude', 'skills'), 'project', '', projectId)).sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- MCP ----------

function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const key of ['env', 'headers']) {
    const inner = copy[key]
    if (inner && typeof inner === 'object') {
      copy[key] = Object.fromEntries(Object.keys(inner).map((k) => [k, '••••••']))
    }
  }
  return copy
}

export function toMcpInfo(s: McpServerStatus, projectId?: string): McpInfo {
  return {
    id: `mcp:${projectId ?? 'user'}:${s.name}`,
    name: s.name,
    status: s.status,
    scope: s.scope,
    source: s.source,
    error: s.error,
    tools: (s.tools ?? []).map((t) => t.name),
    config: redact(s.config),
    projectId
  }
}

/** Project-owned MCP servers are the ones from .mcp.json (project) and ~/.claude.json projects[path] (local). */
export function isProjectScoped(s: McpServerStatus): boolean {
  return s.scope === 'project' || s.scope === 'local'
}

// ---------- CLAUDE.md ----------

/** The project's CLAUDE.md: ./CLAUDE.md, else ./.claude/CLAUDE.md, else ./CLAUDE.md to be created. */
export function claudeMdPath(projectPath: string): string {
  const root = join(projectPath, 'CLAUDE.md')
  const nested = join(projectPath, '.claude', 'CLAUDE.md')
  if (existsSync(root)) return root
  if (existsSync(nested)) return nested
  return root
}

export async function readClaudeMd(projectPath: string): Promise<{ path: string; content: string; exists: boolean }> {
  const path = claudeMdPath(projectPath)
  try {
    return { path, content: await readFile(path, 'utf8'), exists: true }
  } catch {
    return { path, content: '', exists: false }
  }
}

export async function writeClaudeMd(projectPath: string, content: string): Promise<string> {
  const path = claudeMdPath(projectPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}
