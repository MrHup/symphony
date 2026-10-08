// Runs Symphony as a headless remote machine under plain Node, without Electron (src/headless/):
// esbuild bundles the sources with Electron replaced by src/headless/electron.ts, then the bundle
// runs in this process.
//
//   npm run headless -- <command>        (npm run headless -- help lists the commands)
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
// Inside the project (out/ is ignored by git) so the bundle resolves packages from node_modules.
const outfile = join(root, 'out', 'headless', 'index.mjs')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'src', 'headless', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: join(root, 'tsconfig.node.json'),
  alias: { electron: join(root, 'src', 'headless', 'electron.ts') },
  // Packages stay in node_modules (resolved from the project); only the sources are bundled.
  packages: 'external',
  define: { SYMPHONY_VERSION: JSON.stringify(version) },
  logLevel: 'warning'
})

await import(pathToFileURL(outfile).href)
