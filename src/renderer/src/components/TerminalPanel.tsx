import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { splitMachine, withMachine } from '@shared/remote'
import { api, terminalBus, useStore, type Panel } from '../store'
import { FloatingPanel } from './FloatingPanel'

// Text and chrome stay monochrome. Programs' ANSI colors are kept (an error should still read as one)
// but muted and desaturated, well below the signal color, like the diff viewer's tints.
const theme: ITheme = {
  background: '#131312',
  foreground: '#D9D5CC',
  cursor: '#E9E5DC',
  cursorAccent: '#131312',
  selectionBackground: '#3B3A36',
  black: '#2A2926',
  red: '#B0685E',
  green: '#7E9C70',
  yellow: '#B3A27A',
  blue: '#7D8DA3',
  magenta: '#9A8096',
  cyan: '#7C9E9C',
  white: '#B7B3AA',
  brightBlack: '#5E5C56',
  brightRed: '#C08378',
  brightGreen: '#97B08A',
  brightYellow: '#C7B992',
  brightBlue: '#98A6B8',
  brightMagenta: '#B09AAC',
  brightCyan: '#97B3B1',
  brightWhite: '#E9E5DC'
}

const isMac = window.symphony.platform === 'darwin'

/**
 * targetId is `<projectId>#n`, `home#n`, `@<machineId>/home#n` (a remote machine's home folder), or
 * `claude-login#n` (the bundled Claude Code binary running /login).
 */
export function TerminalPanel({ panel }: { panel: Panel }) {
  const raw = panel.targetId.split('#')[0]
  const home = splitMachine(raw)
  const where = home?.id ?? raw
  const login = where === 'claude-login'
  const projectId = where === 'home' || login ? null : where
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const machineId = home?.machineId ?? project?.machineId
  const machine = useStore((s) => (machineId ? s.machines[machineId] : undefined))
  const host = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useState('Terminal')

  useEffect(() => {
    // A remote machine's terminal carries its prefix, so its output comes back to this panel.
    const id = machineId ? withMachine(machineId, panel.id) : panel.id
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // Copy with Ctrl+C only when text is selected (otherwise it interrupts, as in any terminal); paste with Ctrl+V.
    term.attachCustomKeyEventHandler((e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (e.type !== 'keydown' || !mod) return true
      if (e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (e.key === 'v') return false // let the browser's paste event deliver the text
      return true
    })

    let disposed = false
    const offInput = term.onData((d) => void api.termWrite(id, d))
    const offBus = terminalBus.listen(id, {
      data: (d) => term.write(d),
      exit: (code) => term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
    })
    const resize = () => {
      if (disposed || !host.current?.offsetWidth) return
      fit.fit()
      void api.termResize(id, term.cols, term.rows)
    }
    const observer = new ResizeObserver(resize)

    // Measure the cell size with the real font, not a fallback.
    void document.fonts.ready.then(async () => {
      if (disposed || !host.current) return
      term.open(host.current)
      fit.fit()
      observer.observe(host.current)
      try {
        setShell(await (login ? api.claudeLogin(id, term.cols, term.rows) : api.termStart(id, projectId, term.cols, term.rows, home?.machineId)))
        term.focus()
      } catch (err) {
        term.write(`\x1b[90m${String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`)
      }
    })

    return () => {
      disposed = true
      observer.disconnect()
      offInput.dispose()
      offBus()
      void api.termKill(id).catch(() => undefined)
      term.dispose()
    }
  }, [panel.id, projectId, machineId, login, home?.machineId])

  return (
    <FloatingPanel panel={panel} machineId={machineId} title={login ? shell : `${shell} · ${project?.name ?? (machine ? `~ on ${machine.name}` : '~')}`} meta={project?.path}>
      <div className="terminal-host" ref={host} onMouseDown={() => host.current?.querySelector('textarea')?.focus()} />
    </FloatingPanel>
  )
}
