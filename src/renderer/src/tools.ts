// The tools a machine node offers (src/main/tools.ts has their main-process parts). Each one opens its
// own panel for the machine it was picked on.
import type { ReactNode } from 'react'
import type { Panel } from './store'

export interface ToolEntry {
  id: string
  name: string
  description: string
  Panel(props: { panel: Panel; machineId?: string }): ReactNode
}

export const TOOLS: ToolEntry[] = []

/** A tool panel's target: the tool and the machine it runs on. */
export const toolTarget = (tool: string, machineId?: string) => `${tool}@${machineId ?? 'local'}`
