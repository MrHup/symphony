// The prompt pipeline: a prompt from a project node first goes through /optimize-prompt, and the
// fenced block under "## Optimized prompt" in that session's reply becomes the first message of
// the real session, run with the same model.
import { REFERENCES_DIR } from './references'

/** The rewritten prompt from an optimize-prompt reply, or null when the reply has no such block. */
export function extractOptimizedPrompt(reply: string): string | null {
  const heading = reply.search(/^#{1,6}\s*Optimized prompt\s*$/im)
  if (heading < 0) return null
  const rest = reply.slice(heading)
  // The skill uses ```text, but accept any info string and longer fences (used when the prompt itself contains ```).
  const fence = rest.match(/^(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m)
  const body = fence?.[2]?.trim()
  return body ? body : null
}

/**
 * The optimize step must stay a plain-text message: Claude Code does not dispatch a slash command
 * whose message carries images. So the optimizer gets a note about pasted images instead, and the
 * images themselves go with the optimized prompt to the real session.
 */
export function optimizeCommand(prompt: string, imageCount = 0, context?: string): string {
  const one = imageCount === 1
  const notes = [
    imageCount
      ? `(The user attached ${one ? 'an image' : `${imageCount} images`} to this prompt. ${one ? 'It is' : 'They are'} sent along with the optimized prompt, so keep any references to ${one ? 'it' : 'them'}, e.g. "the attached screenshot".)`
      : '',
    prompt.includes(`${REFERENCES_DIR}/`)
      ? `(Paths under ${REFERENCES_DIR}/ are files the user added to the project for this task. Keep every one exactly as written, including its leading @.)`
      : '',
    context ? `(${context})` : ''
  ].filter(Boolean)
  return `/optimize-prompt ${prompt.trim()}${notes.length ? `\n\n${notes.join('\n\n')}` : ''}`
}

/** How long the finished optimize node stays on the graph before it is removed. */
export const OPTIMIZE_LINGER_MS = 2500
