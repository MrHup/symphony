// Embedded terminals: one pseudo-terminal per terminal panel, streamed to the renderer.
import { spawn, type IPty } from '@lydell/node-pty'
import { basename } from 'node:path'
import type { MainEvent } from '@shared/types'
import { terminalShell } from './platform'

export class TerminalManager {
  private terms = new Map<string, IPty>()

  constructor(private emit: (e: MainEvent) => void) {}

  /** Starts the shell (or `command`) and returns its display name. */
  start(id: string, cwd: string, cols: number, rows: number, command?: { file: string; args: string[]; name: string }): string {
    const shell = command ?? terminalShell()
    const name = command?.name ?? shellName(shell.file)
    if (this.terms.has(id)) return name
    const env = { ...process.env, TERM_PROGRAM: 'Symphony' } as Record<string, string>
    // Never leak Electron's "run as Node" switch into the user's shell.
    delete env.ELECTRON_RUN_AS_NODE
    const term = spawn(shell.file, shell.args, { name: 'xterm-256color', cwd, env, cols: Math.max(2, cols), rows: Math.max(2, rows) })
    this.terms.set(id, term)
    term.onData((data) => this.emit({ type: 'term', id, data }))
    term.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.emit({ type: 'termExit', id, code: exitCode })
    })
    return name
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      // The process may have exited between the resize and now.
    }
  }

  /** Stop reading a terminal's output for a while (the link's send buffer is full). */
  pause(id: string): void {
    this.terms.get(id)?.pause()
  }

  resume(id: string): void {
    this.terms.get(id)?.resume()
  }

  kill(id: string): void {
    const term = this.terms.get(id)
    this.terms.delete(id)
    try {
      term?.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}

function shellName(file: string): string {
  const base = basename(file).replace(/\.exe$/i, '').toLowerCase()
  if (base === 'pwsh' || base === 'powershell') return 'PowerShell'
  return base
}
