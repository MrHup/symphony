// The tools a machine node offers (src/main/tools.ts has their main-process parts). Each one opens its
// own panel for the machine it was picked on.
import type { ReactNode } from 'react'
import { MobileUiPanel } from '../../tools/mobile-ui/Panel'
import type { Panel } from './store'

export interface ToolEntry {
  id: string
  name: string
  description: string
  Panel(props: { panel: Panel; machineId?: string }): ReactNode
}

export const TOOLS: ToolEntry[] = [
  {
    id: 'mobile-ui',
    name: 'Mobile UI',
    description: 'A working replica of a mobile app with its documentation, previewed on your phone',
    Panel: MobileUiPanel
  }
]

/** A tool panel's target: the tool and the machine it runs on. */
export const toolTarget = (tool: string, machineId?: string) => `${tool}@${machineId ?? 'local'}`
