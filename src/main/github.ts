// GitHub identity through gh. Each session is pinned to the account that is active for its
// remote's host when the session starts: Symphony passes that account's token into the session's
// environment (see ghCredentialEnv), so the account shown on the node is the one git and gh use.
import type { GhAccounts, GhIdentity, LoginPrompt } from '@shared/types'
import { ghCredentialEnv, ghPath, run, spawnPiped } from './platform'

interface RawAccount {
  login?: string
  active?: boolean
  state?: string
  host?: string
}

export async function getAccounts(): Promise<GhAccounts> {
  const gh = ghPath()
  if (!gh) return { installed: false, hosts: {} }
  const res = await run(gh, ['auth', 'status', '--json', 'hosts'], { timeoutMs: 20_000 })
  const hosts: GhAccounts['hosts'] = {}
  try {
    const parsed = JSON.parse(res.stdout) as { hosts?: Record<string, RawAccount[]> }
    for (const [host, list] of Object.entries(parsed.hosts ?? {})) {
      hosts[host] = list
        .filter((a) => a.login)
        .map((a) => ({ login: a.login!, active: !!a.active, state: a.state ?? 'unknown' }))
    }
  } catch {
    // Older gh without --json: treat as no accounts rather than guessing from text output.
  }
  return { installed: true, hosts }
}

/** Identity plus the environment a session needs so git and gh act as that account. */
export async function resolveIdentity(host: string, accounts: GhAccounts): Promise<{ identity: GhIdentity; env: Record<string, string> }> {
  const active = accounts.hosts[host]?.find((a) => a.active && a.state === 'success')
  const gh = ghPath()
  if (!active || !gh) return { identity: { host, login: null }, env: {} }
  const token = await run(gh, ['auth', 'token', '--hostname', host, '--user', active.login])
  const value = token.stdout.trim()
  if (token.code !== 0 || !value) return { identity: { host, login: active.login }, env: {} }
  return { identity: { host, login: active.login }, env: ghCredentialEnv(host, value) }
}

/**
 * Device-flow login without a terminal: gh prints a one-time code and a URL, Symphony shows the
 * code and opens the URL, and gh exits once the user approves in the browser.
 */
export function login(onUpdate: (p: LoginPrompt) => void, openUrl: (url: string) => void): void {
  const gh = ghPath()
  if (!gh) {
    onUpdate({ code: null, url: null, done: true, error: 'gh is not installed' })
    return
  }
  const child = spawnPiped(gh, ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'])
  const prompt: LoginPrompt = { code: null, url: null, done: false }
  let output = ''
  const onData = (chunk: Buffer) => {
    output += chunk.toString()
    const code = output.match(/one-time code[^A-Z0-9]*\(?([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] ?? null
    const url = output.match(/https:\/\/\S+\/login\/device/)?.[0] ?? null
    if (code !== prompt.code || url !== prompt.url) {
      const opening = !prompt.url && url
      prompt.code = code
      prompt.url = url
      onUpdate({ ...prompt })
      if (opening && url) openUrl(url)
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  // Some gh versions wait for Enter before continuing.
  child.stdin?.write('\n')
  child.on('exit', (code) => {
    onUpdate({ ...prompt, done: true, error: code === 0 ? undefined : output.trim().split('\n').pop() })
  })
}
