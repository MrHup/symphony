// Symphony runs Claude Code on the user's Claude subscription only, never on per-token billing.
// Three layers, because an API key can reach Claude Code from several places:
//   1. subscriptionEnv() strips billing variables from the environment Symphony passes on, and
//      subscriptionSettings() blanks the key variables in the highest settings layer, so a
//      project's settings.json `env` block cannot bring them back.
//   2. subscriptionProblem() checks the login before a session sends its first message. This
//      catches an apiKeyHelper, a non-Anthropic provider (Bedrock, Vertex, ...) or a missing login.
//   3. keySourceProblem() checks every turn's init message; the session manager stops the session
//      when Claude Code reports any API key source.
import type { Query, Settings } from '@anthropic-ai/claude-agent-sdk'

/** Variables that switch Claude Code to an API key, a token, a proxy or a cloud provider. */
const BILLING_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
]

export function subscriptionEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !BILLING_VARS.includes(k)) env[k] = v
  // VS Code exports this to child processes; Claude Code itself must not inherit it.
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...extra }
}

/** Flag-layer settings (above user/project/local) that blank the key variables. */
export const subscriptionSettings: Settings = { env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' } }

/** Null when Claude Code is signed in with a Claude subscription; otherwise why it is not. */
export async function subscriptionProblem(q: Query): Promise<string | null> {
  const { account } = await q.initializationResult()
  if (account.apiProvider && account.apiProvider !== 'firstParty') {
    return `Claude Code is configured to use ${account.apiProvider} instead of your Claude subscription.`
  }
  if (account.apiKeySource && account.apiKeySource !== 'none') {
    return `Claude Code would use an API key (from ${account.apiKeySource}), which is billed per token. Remove it from your Claude Code settings to use your subscription.`
  }
  if (!account.subscriptionType) {
    return 'Claude Code is not signed in with a Claude subscription. Open a terminal, run claude, and sign in with /login.'
  }
  return null
}

/** Null when a turn runs without an API key; `apiKeySource` comes from the turn's init message. */
export function keySourceProblem(apiKeySource: string): string | null {
  return apiKeySource === 'none' ? null : `Stopped: Claude Code switched to an API key (from ${apiKeySource}), which is billed per token.`
}
