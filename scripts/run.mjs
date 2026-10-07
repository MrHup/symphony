// Runs electron-vite with ELECTRON_RUN_AS_NODE cleared. Shells spawned by VS Code (and some other
// Electron-based tools) export that variable, which makes Electron start as plain Node and fail.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// The bin script is not in the package's exports map, so locate it next to package.json.
const pkg = createRequire(import.meta.url).resolve('electron-vite/package.json')
const cli = join(dirname(pkg), 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
