// The tools the dock's tools button offers (src/main/tools.ts has their main-process parts). A tool
// belongs to Symphony as a whole: its panel spans every machine, and each run of it picks the machine
// it runs on.
import type { ReactNode } from 'react'
import { MobileUiPanel } from '../../tools/mobile-ui/Panel'
import type { Panel } from './store'

export interface ToolEntry {
  id: string
  name: string
  description: string
  Panel(props: { panel: Panel }): ReactNode
}

export const TOOLS: ToolEntry[] = [
  {
    id: 'mobile-ui',
    name: 'Mobile UI',
    description: 'A working replica of a mobile app with its documentation, previewed on your phone',
    Panel: MobileUiPanel
  }
]
