// Loop graphs: loops saved as chains still load, steps run in their own folders with the edge's
// prompt in front, a human sends the loop back with a prompt, and deleting a loop removes its
// temporary folders. Sessions are faked; the folders are real.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { LoopDraft, LoopInfo, Project } from '../src/shared/types'
import { LoopManager } from '../src/main/loops'
import type { SessionManager, StartOptions } from '../src/main/sessions'
import { setDataDir } from '../src/main/store'

const dataDir = mkdtempSync(join(tmpdir(), 'symphony-loop-test-'))
setDataDir(dataDir)

function manager() {
  const started: (StartOptions & { id: string })[] = []
  const sessions = {
    start: (o: StartOptions) => (started.push({ ...o, id: `s${started.length}` }), { id: `s${started.length - 1}` }),
    list: () => [],
    archive: () => undefined,
    dismiss: () => undefined,
    send: () => undefined,
    stop: async () => undefined
  }
  const loops = new LoopManager({
    sessions: sessions as unknown as SessionManager,
    emit: () => undefined,
    persist: () => undefined,
    identityFor: async () => ({ identity: { host: 'github.com', login: null }, env: {} }),
    defaultModel: () => 'opus'
  })
  /** The step session `i` ends its turn. */
  const finish = async (i: number) => {
    started[i].onResult?.('', false)
    await new Promise((r) => setTimeout(r, 10))
  }
  return { loops, started, finish }
}

const at = { x: 0, y: 0 }

/** Build → Check (agent) → Review (human), each agent working in `work`. */
function draft(work: string): LoopDraft {
  return {
    name: 'Report',
    steps: [
      { id: 'build', kind: 'agent', title: 'Build', prompt: 'Build the report.', position: at },
      { id: 'check', kind: 'agent', title: 'Check', prompt: 'Check the report.', position: at },
      { id: 'review', kind: 'human', title: 'Review', prompt: '', position: at }
    ],
    folders: [
      { id: 'work', name: 'work', path: work, position: at },
      { id: 'in', name: 'in', position: at },
      { id: 'out', name: 'out', position: at },
      { id: 'pages', name: 'pages', parentId: 'out', position: at }
    ],
    links: [
      { stepId: 'build', folderId: 'work', role: 'session' },
      { stepId: 'build', folderId: 'in', role: 'input' },
      { stepId: 'build', folderId: 'out', role: 'output' },
      { stepId: 'check', folderId: 'work', role: 'session' },
      { stepId: 'check', folderId: 'out', role: 'input' },
      { stepId: 'check', folderId: 'pages', role: 'output' },
      { stepId: 'review', folderId: 'pages', role: 'input' }
    ],
    edges: [
      { id: 'e1', from: 'build', to: 'check', prompt: 'Look hard at the charts.' },
      { id: 'e2', from: 'check', to: 'review' }
    ],
    start: 'build',
    maxRuns: 12,
    optimize: false
  }
}

describe('loops', () => {
  test('a loop saved as a chain on a project loads as a graph on that project folder', () => {
    const { loops } = manager()
    const project: Project = { id: 'p1', path: '/work/site', name: 'site', position: at }
    const old = { id: 'l1', projectId: 'p1', name: 'Old', steps: [{ id: 'a', kind: 'agent', title: 'A', prompt: 'x' }, { id: 'h', kind: 'human', title: 'H', prompt: '' }], maxRuns: 12, state: 'waiting', current: 1, runs: 2, history: [{ fromStep: 0, summary: 's', artifacts: [] }], createdAt: 1 }
    loops.restore([old as unknown as LoopInfo], [project])
    const l = loops.list()[0]
    assert.equal('projectId' in l, false)
    assert.deepEqual(l.folders.map((f) => f.path), ['/work/site'])
    assert.deepEqual(l.links, [{ stepId: 'a', folderId: l.folders[0].id, role: 'session' }])
    assert.deepEqual(l.edges.map((e) => [e.from, e.to]), [['a', 'h']])
    assert.equal(l.start, 'a')
    assert.equal(l.current, 'h')
    assert.deepEqual(l.history, [])
  })

  test('steps run in their session folder, see their folders, and get the edge prompt in front', async () => {
    const { loops, started, finish } = manager()
    const work = mkdtempSync(join(tmpdir(), 'symphony-loop-work-'))
    const l = loops.create(draft(work))
    await loops.start(l.id)
    const temp = join(dataDir, 'loops', l.id)
    assert.ok(existsSync(join(temp, 'out', 'pages')), 'temporary and nested folders are created')
    assert.equal(started[0].cwd, work)
    assert.deepEqual(started[0].additionalDirectories, [join(temp, 'in'), join(temp, 'out')])
    assert.match(started[0].prompt, new RegExp(`Input folder.*${join(temp, 'in').replace(/\\/g, '\\\\')}`))
    assert.equal(started[0].tools, undefined, 'one way out needs no routing tool')

    await finish(0)
    assert.ok(started[1].prompt.startsWith('Look hard at the charts.'))
    assert.deepEqual(started[1].additionalDirectories, [join(temp, 'out'), join(temp, 'out', 'pages')])

    await finish(1)
    assert.equal(loops.list()[0].state, 'waiting')
    assert.equal(loops.list()[0].current, 'review')

    // Back to Build with a prompt; it goes in front of Build's own.
    await loops.decide(l.id, { decision: 'back', step: 'build', prompt: 'Use the 2024 numbers.' })
    assert.ok(started[2].prompt.startsWith('Use the 2024 numbers.'))
    await finish(2)
    await finish(3)
    await loops.decide(l.id, { decision: 'forward' })
    assert.equal(loops.list()[0].state, 'done')

    loops.delete(l.id)
    assert.equal(existsSync(temp), false, 'temporary folders go with the loop')
    assert.ok(existsSync(work), 'a permanent folder stays')
  })

  test('a step with several ways out gets loop_route; a loop missing folders does not start', async () => {
    const { loops, started } = manager()
    const work = mkdtempSync(join(tmpdir(), 'symphony-loop-work-'))
    const d = draft(work)
    d.edges.push({ id: 'e3', from: 'build', to: 'review' })
    const l = loops.create(d)
    await loops.start(l.id)
    assert.ok(started[0].tools?.allowedTools.includes('mcp__symphony_loop__loop_route'))
    assert.match(started[0].prompt, /1\. the step "Check"\n2\. the step "Review" \(a human review\)/)

    const missing = loops.create({ ...draft(work), links: draft(work).links.filter((k) => k.role !== 'output') })
    await assert.rejects(loops.start(missing.id), /Connect "Build" to its output folder/)
  })
})
