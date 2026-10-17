// Mobile UI types shared by the tool's core, its preview server and its panel.
import type { EffortLevel, NodeStatus } from '@shared/types'

export const TOOL_ID = 'mobile-ui'

/** A UI recipe: a working replica of a mobile app (app/) and its documentation (docs/), in its own folder. */
export interface Recipe {
  id: string
  name: string
  /** What the user asked for. */
  prompt: string
  /** The folder the recipe was built from, on the recipe's machine. */
  source?: string
  /** The recipe's folder, on its machine. It is also a project there, so its sessions show on the graph. */
  dir: string
  projectId: string
  model: string
  effort?: EffortLevel
  createdAt: number
  /** When a file in app/ last changed: the preview reloads when this moves. */
  version: number
  /** Sessions working on the recipe, newest first: the one that made it, then one per comment. */
  sessions: RecipeSession[]
}

export interface RecipeSession {
  id: string
  title: string
  status: NodeStatus
}

export interface MobileUiState {
  recipes: Recipe[]
}

/** What the panel sends to create a recipe. */
export interface RecipeDraft {
  name: string
  prompt: string
  /** A project on the recipe's machine to build from. */
  sourceProjectId?: string
  model: string
  effort?: EffortLevel
}

/** A comment sent from the phone preview. */
export interface PhoneComment {
  text: string
  /** The app's route when the comment was made, e.g. "#/home?state=empty". */
  route: string
  viewport: { width: number; height: number }
  /** What the comment is about: one component, or the whole view. */
  target: {
    kind: 'component' | 'view'
    /** CSS selector of the selected element in the app's page. */
    selector: string
    /** Its data-ui (component) or data-screen (view) name, when it has one. */
    name?: string
    /** Its markup, shortened. */
    html: string
    text: string
  }
}

/** A preview the phone can open, served by the machine with the window. */
export interface Preview {
  machineId?: string
  recipeId: string
  /** One link per local-network address; the first is the likely one. */
  urls: string[]
  /** The first link as a QR code (SVG). */
  qr: string
}

/** A file of a recipe's app, as the preview server gets it. */
export type RecipeFile = { etag: string; type: string; data?: string }
