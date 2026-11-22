import type { MachineState, NodeStatus } from '@shared/types'
import { api, claimForWorkspace, clock, machineName, machineUp, useLock, useStore } from '../store'
import { Glyph } from './Glyph'
import { IconAutoApprove, IconBattery, IconFolder, IconLoop, IconTerminal } from './icons'

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** A machine that went away: how it went (never the signal color, nothing waits for you). */
export function downState(m: MachineState | undefined): 'offline' | 'asleep' | 'quit' | null {
  if (!m || machineUp(m) || m.status === 'pairing') return null
  return m.status === 'asleep' ? 'asleep' : m.status === 'quit' ? 'quit' : 'offline'
}

/** The class that tints a machine's tags and glyphs with its color, or ''. */
export function useTint(machineId?: string): string {
  const color = useStore((s) => s.machineColors[machineId ?? 'local'])
  return color ? ` accent-${color}` : ''
}

/**
 * The machine a session, project or loop runs on: its name in its color. An offline, asleep or quit
 * machine's tag is dashed and says so.
 */
export function MachineTag({ machineId }: { machineId?: string }) {
  const name = useStore((s) => machineName(s, machineId))
  const machine = useStore((s) => (machineId ? s.machines[machineId] : undefined))
  const tint = useTint(machineId)
  const down = downState(machine)
  return (
    <span className={`machine-pill${tint}${down ? ' is-down' : ''}`} title={down && machine ? `${name} is ${down} since ${clock(machine.since)}` : `Runs on ${name}`}>
      {name}
      {down && <span className="machine-pill-state"> · {down}</span>}
    </span>
  )
}

function machineSub(m: MachineState): string {
  switch (m.status) {
    case 'online':
      return PLATFORM[m.platform] ?? m.platform
    case 'reconnecting':
      return 'reconnecting'
    case 'pairing':
      return 'wants to pair · click to compare the code'
    case 'asleep':
      return `asleep · since ${clock(m.since)}`
    case 'quit':
      return `quit · ${clock(m.since)}`
    case 'offline':
      return `offline · since ${clock(m.since)}`
  }
}

/** Each machine's own auto-approve (missing machineId means this one). */
function AutoApproveToggle({ on, name, machineId, lock }: { on: boolean; name: string; machineId?: string; lock: string | null }) {
  return (
    <button
      className={`icon-btn${on ? ' is-on' : ''}`}
      aria-pressed={on}
      disabled={!!lock}
      title={lock ?? (on ? `Auto-approve is on for ${name}. Click to turn off.` : `Auto-approve on ${name}: allow permission prompts without asking`)}
      onClick={() => void api.setAutoApprove(!on, machineId)}
    >
      <IconAutoApprove size={14} />
    </button>
  )
}

/** The machine-level actions: auto-approve, a new loop, adding a project folder, a terminal in the home folder. */
function MachineActions({ machine, name }: { machine?: MachineState; name: string }) {
  const machineId = machine?.id
  const lock = useLock(machineId)
  const localAutoApprove = useStore((s) => s.autoApprove)
  const terminals = !machine || machine.terminals
  return (
    <div className="machine-actions">
      <AutoApproveToggle on={machine ? machine.autoApprove : localAutoApprove} name={name} machineId={machineId} lock={lock} />
      {/* A loop belongs to a machine and runs there. */}
      <button className="icon-btn" disabled={!!lock} title={lock ?? `New loop on ${name}`} onClick={() => useStore.getState().newLoop(machineId)}>
        <IconLoop />
      </button>
      {/* This PC's folder picker, or a remote machine's shared folders. */}
      <button
        className="icon-btn"
        disabled={!!lock}
        title={lock ?? (machineId ? `Add a project from the folders ${name} shares` : `Add a project folder on ${name}`)}
        onClick={() => {
          if (machineId) useStore.getState().openPanel('folders', machineId)
          else void api.addProject().then(claimForWorkspace)
        }}
      >
        <IconFolder />
      </button>
      {terminals && (
        <button className="icon-btn" disabled={!!lock} title={lock ?? `Terminal in the home folder of ${name}`} onClick={() => useStore.getState().openTerminal(null, machineId)}>
          <IconTerminal />
        </button>
      )}
    </div>
  )
}

const NO_GH = { installed: false, hosts: {} }

/** The GitHub account gh uses on a machine (each machine has its own login), or a way to sign in. */
function GitHubLine({ machineId }: { machineId?: string }) {
  const gh = useStore((s) => (machineId ? (s.machines[machineId]?.gh ?? NO_GH) : s.gh))
  const lock = useLock(machineId)
  const accounts = Object.entries(gh.hosts).flatMap(([host, list]) => list.filter((a) => a.active).map((a) => (host === 'github.com' ? a.login : `${a.login}@${host}`)))
  if (!gh.installed) return <span className="identity is-none">gh not installed</span>
  if (accounts.length) return <span className="identity" title="GitHub account new sessions use">{accounts.map((a) => `@${a}`).join(' ')}</span>
  return (
    <button
      className="identity is-none"
      disabled={!!lock}
      title={lock ?? undefined}
      onClick={(e) => {
        e.stopPropagation()
        useStore.getState().openPanel('login', machineId ?? 'local')
        void api.ghLogin(machineId)
      }}
    >
      sign in to GitHub
    </button>
  )
}

/**
 * One machine in the sidebar: its state, its GitHub account and its actions. Right-click picks its
 * color. A machine asking to pair shows the signal square and opens the code to compare.
 */
export function MachineCard({ machine }: { machine?: MachineState }) {
  const name = machine?.name ?? 'This PC'
  const tint = useTint(machine?.id)
  const up = !machine || machineUp(machine)
  const pairing = machine?.status === 'pairing'
  const status: NodeStatus = pairing ? 'input' : machine?.status === 'reconnecting' ? 'working' : 'idle'
  const battery = machine?.health && !machine.health.charging && machine.health.battery !== null ? machine.health.battery : null

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const s = useStore.getState()
    // The color is kept here, so it can be changed while that machine is offline.
    if (s.control || pairing) return
    const r = e.currentTarget.getBoundingClientRect()
    s.setColorMenu({ machineId: machine?.id ?? 'local', left: r.left, right: r.right, top: r.top })
  }

  return (
    <div
      className={`machine-card${tint}${up || pairing ? '' : ' is-down'}${pairing ? ' is-pairing' : ''}`}
      title={machine ? `${PLATFORM[machine.platform] ?? machine.platform}${machine.appVersion ? ` · Symphony ${machine.appVersion}` : ''}\nRight-click to pick its color` : 'This machine\nRight-click to pick its color'}
      onContextMenu={onContextMenu}
      onClick={() => pairing && machine && useStore.getState().openPanel('pairing', machine.id)}
    >
      <div className="machine-head">
        <Glyph status={status} size={13} variant={up || pairing ? 'hub' : 'failed'} />
        <span className="machine-name">{name}</span>
      </div>
      <div className="machine-lines">
        {machine && (
          <span className="machine-sub">
            <span>{machineSub(machine)}</span>
            {up && battery !== null && (
              <span className="battery" title={`On battery, ${battery}%`}>
                <IconBattery level={battery / 100} />
                {battery}%{battery < 15 && ' · low · may sleep'}
              </span>
            )}
            {up && machine.health?.lowPower && <span>low power mode</span>}
          </span>
        )}
        {machine?.outdated && <span className="machine-sub">update Symphony on this machine</span>}
        {!pairing && <GitHubLine machineId={machine?.id} />}
        {!pairing && <MachineActions machine={machine} name={name} />}
      </div>
    </div>
  )
}
