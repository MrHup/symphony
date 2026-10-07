// Runs the protocol, control and security tests of remote orchestration (test/*.test.ts) under
// plain Node: esbuild bundles each test with Electron replaced by a stub, then node --test runs it.
//
//   npm test
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// Inside the project (out/ is ignored by git) so the bundles resolve packages from node_modules.
const out = join(root, 'out', 'tests')
mkdirSync(out, { recursive: true })
const tests = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts'))

await build({
  entryPoints: tests.map((f) => join(root, 'test', f)),
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: join(root, 'tsconfig.node.json'),
  alias: { electron: join(root, 'test', 'stubs', 'electron.mjs') },
  // Packages stay in node_modules (resolved from the project); only the sources are bundled.
  packages: 'external',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning'
})

const files = tests.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))
const env = { ...process.env, SYMPHONY_REMOTE_LOOPBACK: '1' }
delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=30000', '--test-reporter=spec', ...files], { stdio: 'inherit', env, cwd: root })
process.exit(res.status ?? 1)
