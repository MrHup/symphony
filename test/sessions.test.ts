// When a session's Claude Code process closes after going idle. The process is faked: the test
// feeds it messages and watches for close(). The idle window is shortened to keep the tests fast.
//
// Regression: the process used to close a fixed time after a turn's result, even while background
// subagents or shells were still running (they died with it), and even in the middle of a turn
// Claude Code had started on its own to read a background task's notification.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { query as realQuery, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AssetStore } from '../src/main/assets'
import { SessionManager } from '../src/main/sessions'
import { setDataDir } from '../src/main/store'

setDataDir(mkdtempSync(join(tmpdir(), 'symphony-session-test-')))

const IDLE = 150
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A stand-in for one Claude Code process. */
class FakeProcess implements AsyncIterable<SDKMessage> {
  closed = false
  private queue: SDKMessage[] = []
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null

  constructor(prompt: AsyncIterable<unknown>) {
    // Drain the input like Claude Code would.
    void (async () => {
      for await (const _ of prompt) void _
    })()
  }

  send(msg: Record<string, unknown>): void {
    const m = { uuid: randomUUID(), session_id: 'sdk-session', ...msg } as unknown as SDKMessage
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: m, done: false })
    } else this.queue.push(m)
  }

  close(): void {
    this.closed = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = null
  }

  async interrupt(): Promise<void> {}

  async initializationResult() {
    return { account: { subscriptionType: 'max', apiKeySource: 'none', apiProvider: 'firstParty' } }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.queue.shift()
        if (m) return Promise.resolve({ value: m, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => (this.waiter = r))
      }
    }
  }
}

// Message shapes Claude Code sends; only the fields Symphony reads.
const result = () => ({ type: 'result', subtype: 'success', result: 'Done.', is_error: false, total_cost_usd: 0, duration_ms: 1 })
const taskStarted = (id: string, task_type = 'local_agent', extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  task_type,
  tool_use_id: `tool-${id}`,
  description: `task ${id}`,
  ...extra
})
const taskDone = (id: string) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', output_file: '', summary: '' })
const mainText = () => ({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null })
const subagentText = (id: string) => ({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: `tool-${id}` })

function harness() {
  const procs: FakeProcess[] = []
  const fakeQuery = ((args: { prompt: AsyncIterable<unknown> }) => {
    const p = new FakeProcess(args.prompt)
    procs.push(p)
    return p as unknown as Query
  }) as unknown as typeof realQuery
  const sm = new SessionManager(() => undefined, () => undefined, {} as AssetStore, { query: fakeQuery, idleCloseMs: IDLE })
  const info = sm.start({ kind: 'task', anchorId: 'a', projectId: null, cwd: tmpdir(), prompt: 'Go.', model: 'opus', title: 'Test' })
  const status = () => sm.get(info.id)?.status
  return { sm, proc: () => procs[0], procs, status }
}

describe('session idle close', () => {
  test('an idle session closes its process after the idle window', async () => {
    const { proc, status } = harness()
    await wait(10)
    proc().send(result())
    await wait(20)
    assert.equal(status(), 'finished')
    assert.equal(proc().closed, false, 'not before the window ends')
    await wait(IDLE + 50)
    assert.equal(proc().closed, true)
  })

  test('a background subagent keeps the process open past the idle window', async () => {
    const { sm, proc } = harness()
    await wait(10)
    proc().send(taskStarted('t1'))
    proc().send(result())
    await wait(IDLE * 3)
    assert.equal(proc().closed, false, 'the subagent would have been killed')
    assert.equal(sm.busy(), true, 'busy while the subagent runs, so the machine stays awake')
    // The subagent's own output does not make the main session look busy with a turn.
    proc().send(subagentText('t1'))
    await wait(20)
    proc().send(taskDone('t1'))
    await wait(20)
    assert.equal(sm.busy(), false)
    await wait(IDLE + 50)
    assert.equal(proc().closed, true, 'closes once the subagent ended and the window passed')
  })

  test('a background shell counts too; ambient housekeeping does not', async () => {
    const { proc } = harness()
    await wait(10)
    proc().send(taskStarted('watch', 'local_bash', { ambient: true }))
    proc().send(taskStarted('render', 'local_bash'))
    proc().send(result())
    await wait(IDLE * 2)
    assert.equal(proc().closed, false, 'the render would have been killed')
    proc().send(taskDone('render'))
    await wait(IDLE + 50)
    assert.equal(proc().closed, true, 'the ambient watcher does not hold the process open')
  })

  test('a turn Claude Code starts on its own stops the idle countdown until its result', async () => {
    const { proc, status } = harness()
    await wait(10)
    proc().send(result())
    // Halfway through the window, a background notification starts a new turn.
    await wait(IDLE / 2)
    proc().send(mainText())
    await wait(20)
    assert.equal(status(), 'working')
    await wait(IDLE * 2)
    assert.equal(proc().closed, false, 'the earlier countdown must not close the process mid-turn')
    proc().send(result())
    await wait(20)
    assert.equal(status(), 'finished')
    await wait(IDLE + 50)
    assert.equal(proc().closed, true)
  })

  test('a follow-up after the process closed resumes in a new process', async () => {
    const { sm, procs, status } = harness()
    await wait(10)
    procs[0].send(result())
    await wait(IDLE + 50)
    assert.equal(procs[0].closed, true)
    sm.send(sm.list()[0].id, 'Again.')
    await wait(20)
    assert.equal(procs.length, 2)
    assert.equal(status(), 'working')
  })
})
