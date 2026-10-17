// Mobile UI on the machine it runs on: recipes (a folder each, which is also a project there so its
// sessions show on the graph), the sessions that make and change them, their app's files for the
// phone preview, and the capture_screens tool those sessions use for the documentation's screenshots.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ImageInput } from '@shared/types'
import { MAX_FILE_BYTES } from '@shared/remote'
import type { ToolCore, ToolDeps } from '../../main/tools'
import { dataPath, loadJson, saveJson } from '../../main/store'
import { capture, contentType, inside, PHONE } from './capture'
import type { MobileUiState, PhoneComment, Recipe, RecipeDraft, RecipeFile, RecipeSession } from './types'

/** This tool's folder in the repo. Every bundle (out/main, out/headless, out/tests) sits two levels below the root. */
export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools', 'mobile-ui')

const SKILL = 'mobile-ui-recipe'
const CAPTURE_SERVER = 'symphony_mobile_ui'
const CAPTURE_TOOL = `mcp__${CAPTURE_SERVER}__capture_screens`
const STATE_FILE = 'tools/mobile-ui/recipes.json'
const SESSIONS_KEPT = 10
const VERSION_DEBOUNCE_MS = 400
/** Most of a comment's markup and text that reaches the session. */
const MAX_HTML = 4000
const MAX_TEXT = 400

type Saved = Omit<Recipe, 'sessions'> & { sessions: Omit<RecipeSession, 'status'>[] }

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'recipe'

export function mobileUiCore(d: ToolDeps): ToolCore {
  let recipes: Saved[] = []
  const watchers = new Map<string, FSWatcher>()
  const bumps = new Map<string, NodeJS.Timeout>()

  const save = () => saveJson(STATE_FILE, () => recipes)
  const need = (id: string) => {
    const r = recipes.find((x) => x.id === id)
    if (!r) throw new Error('Unknown recipe')
    return r
  }
  const appDir = (r: Saved) => join(r.dir, 'app')
  const view = (r: Saved): Recipe => ({ ...r, sessions: r.sessions.map((s) => ({ ...s, status: d.sessions.get(s.id)?.status ?? 'finished' })) })

  /** The preview reloads when a file in app/ changes, a moment after the last change. */
  const watchApp = (r: Saved) => {
    watchers.get(r.id)?.close()
    try {
      const w = watch(appDir(r), { recursive: true }, () => {
        clearTimeout(bumps.get(r.id))
        bumps.set(
          r.id,
          setTimeout(() => {
            r.version = Date.now()
            save()
            d.changed()
          }, VERSION_DEBOUNCE_MS)
        )
      })
      w.on('error', () => watchers.delete(r.id))
      watchers.set(r.id, w)
    } catch (err) {
      console.error('[mobile-ui] cannot watch', appDir(r), err)
    }
  }

  /** The recipe's folder is a project on this machine; it is added again if it was removed from the graph. */
  const ensureProject = async (r: Saved) => {
    if (d.projects().some((p) => p.id === r.projectId)) return r.projectId
    const p = await d.addProject(r.dir)
    if (!p) throw new Error(`The recipe's folder ${r.dir} is gone.`)
    r.projectId = p.id
    save()
    return p.id
  }

  /** capture_screens, bound to one recipe: its documentation's screenshots, and a check of its work. */
  const captureServer = (r: Saved): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
      name: CAPTURE_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      tools: [
        tool(
          'capture_screens',
          `Screenshot the recipe's app in a headless browser at a phone's size (${PHONE.width}×${PHONE.height} CSS pixels, 2× scale), one PNG per route, saved as docs/screens/<name>.png. Use it for the documentation's screenshots and to check your work: it also reports errors the page raised.`,
          {
            shots: z
              .array(
                z.object({
                  route: z.string().describe('The route, e.g. "#/home" or "#/home?state=empty".'),
                  name: z.string().describe('File name without extension, e.g. "home--empty".')
                })
              )
              .min(1)
              .max(60)
          },
          async (args) => {
            const dir = join(r.dir, 'docs', 'screens')
            mkdirSync(dir, { recursive: true })
            try {
              const shots = await capture(appDir(r), args.shots.map((s) => ({ route: s.route })))
              const lines = await Promise.all(
                shots.map(async (shot, i) => {
                  const name = `${args.shots[i].name.replace(/[^\w.-]+/g, '-')}.png`
                  await writeFile(join(dir, name), shot.png)
                  return `docs/screens/${name}${shot.errors.length ? ` (page errors: ${shot.errors.join(' | ')})` : ''}`
                })
              )
              return { content: [{ type: 'text', text: `Saved:\n${lines.join('\n')}` }] }
            } catch (err) {
              return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
            }
          }
        )
      ]
    })

  /** A session on the recipe, in its folder, under its project on the graph. */
  const run = async (r: Saved, prompt: string, title: string, images?: ImageInput[]) => {
    const projectId = await ensureProject(r)
    const { identity, env } = await d.identityFor(r.dir)
    const s = d.sessions.start({
      kind: 'task',
      anchorId: projectId,
      projectId,
      cwd: r.dir,
      additionalDirectories: r.source ? [r.source] : undefined,
      prompt,
      images,
      model: r.model,
      effort: d.effortFor(r.model, r.effort),
      title,
      identity,
      env,
      tools: { mcpServers: { [CAPTURE_SERVER]: captureServer(r) }, allowedTools: [CAPTURE_TOOL] }
    })
    r.sessions = [{ id: s.id, title }, ...r.sessions].slice(0, SESSIONS_KEPT)
    save()
    d.changed()
    return s.id
  }

  const create = async (draft: RecipeDraft): Promise<Recipe> => {
    const name = draft.name.trim() || draft.prompt.trim().split(/\s+/).slice(0, 4).join(' ')
    if (!draft.prompt.trim()) throw new Error('Describe the app the recipe is for.')
    const source = draft.sourceProjectId ? d.projects().find((p) => p.id === draft.sourceProjectId) : undefined
    if (draft.sourceProjectId && !source) throw new Error('That project is no longer on this machine.')
    let dir = dataPath(join('tools', 'mobile-ui', slug(name)))
    for (let n = 2; existsSync(dir); n++) dir = dataPath(join('tools', 'mobile-ui', `${slug(name)}-${n}`))
    // The starter app, the skill the sessions follow, and the Rive runtime, so the recipe works offline.
    cpSync(join(TOOL_DIR, 'template'), dir, { recursive: true })
    cpSync(join(TOOL_DIR, 'skill'), join(dir, '.claude', 'skills', SKILL), { recursive: true })
    const rive = dirname(createRequire(import.meta.url).resolve('@rive-app/canvas/package.json'))
    mkdirSync(join(dir, 'app', 'vendor', 'rive'), { recursive: true })
    for (const f of ['rive.js', 'rive.wasm']) cpSync(join(rive, f), join(dir, 'app', 'vendor', 'rive', f))
    const r: Saved = {
      id: randomUUID(),
      name,
      prompt: draft.prompt.trim(),
      source: source?.path,
      dir,
      projectId: '',
      model: draft.model,
      effort: draft.effort,
      createdAt: Date.now(),
      version: Date.now(),
      sessions: []
    }
    recipes.push(r)
    watchApp(r)
    await run(r, createPrompt(r), `Mobile UI: ${name}`)
    return view(r)
  }

  const remove = async (id: string) => {
    const r = need(id)
    watchers.get(id)?.close()
    watchers.delete(id)
    clearTimeout(bumps.get(id))
    // Removing the project also removes the recipe's sessions. Their processes may hold the folder for a
    // moment as they close (Windows refuses to delete it then), hence the retries.
    if (d.projects().some((p) => p.id === r.projectId)) await d.removeProject(r.projectId)
    await rm(r.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    recipes = recipes.filter((x) => x !== r)
    save()
    d.changed()
  }

  /** A comment from the phone: a session that makes the change, with a picture of what was selected. */
  const comment = async (id: string, c: PhoneComment) => {
    const r = need(id)
    const text = String(c.text ?? '').trim()
    if (!text) throw new Error('The comment is empty.')
    const width = Math.round(Math.min(1024, Math.max(320, Number(c.viewport?.width) || PHONE.width)))
    const height = Math.round(Math.min(1600, Math.max(480, Number(c.viewport?.height) || PHONE.height)))
    const component = c.target?.kind === 'component'
    let images: ImageInput[] = []
    let errors: string[] = []
    let shotNote = ''
    try {
      const [shot] = await capture(appDir(r), [{ route: c.route, selector: component ? c.target.selector : undefined }], { width, height, thumb: true })
      images = [{ mediaType: 'image/png', data: shot.png.toString('base64'), thumb: `data:image/jpeg;base64,${shot.thumb!.toString('base64')}` }]
      errors = shot.errors
      shotNote = `The attached screenshot shows that view at the phone's size${component ? ', with the selected component outlined in orange' : ''}.`
    } catch (err) {
      shotNote = `No screenshot is attached (${(err as Error).message}).`
    }
    return { sessionId: await run(r, commentPrompt(r, c, text, width, height, shotNote, errors), text.split('\n')[0].slice(0, 120), images) }
  }

  /** A file of the recipe's app; `etag` skips the contents when they did not change. */
  const getFile = async (id: string, rel: string, etag?: string): Promise<RecipeFile> => {
    const file = inside(appDir(need(id)), rel || 'index.html')
    const info = file ? await stat(file).catch(() => null) : null
    if (!file || !info?.isFile()) throw new Error(`Not found: ${rel}`)
    if (info.size > MAX_FILE_BYTES) throw new Error(`${rel} is too large to preview.`)
    const tag = `${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}`
    const type = contentType(file)
    return tag === etag ? { etag: tag, type } : { etag: tag, type, data: (await readFile(file)).toString('base64') }
  }

  /** docs/RECIPE.md with its images inlined, so it can be read on another machine. */
  const getDoc = async (id: string): Promise<string | null> => {
    const docs = join(need(id).dir, 'docs')
    const md = await readFile(join(docs, 'RECIPE.md'), 'utf8').catch(() => null)
    if (md === null) return null
    let budget = MAX_FILE_BYTES
    const parts = await Promise.all(
      md.split(/(!\[[^\]]*\]\([^)\s]+\))/).map(async (part) => {
        const m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part)
        const file = m && !/^[a-z]+:/i.test(m[2]) ? inside(docs, m[2]) : null
        const data = file && contentType(file).startsWith('image/') ? await readFile(file).catch(() => null) : null
        if (!m || !data || (budget -= data.length) < 0) return part
        return `![${m[1]}](data:${contentType(file!)};base64,${data.toString('base64')})`
      })
    )
    return parts.join('')
  }

  return {
    start() {
      recipes = loadJson<Saved[]>(STATE_FILE, []).filter((r) => existsSync(r.dir))
      for (const r of recipes) watchApp(r)
      d.on((e) => {
        if (e.type === 'session' && recipes.some((r) => r.sessions.some((s) => s.id === e.session.id))) d.changed()
        else if (e.type === 'sessionRemoved') {
          const r = recipes.find((x) => x.sessions.some((s) => s.id === e.id))
          if (!r) return
          r.sessions = r.sessions.filter((s) => s.id !== e.id)
          save()
          d.changed()
        }
      })
    },
    state: (): MobileUiState => ({ recipes: recipes.map(view) }),
    async call(method, args) {
      switch (method) {
        case 'create':
          return create(args[0] as RecipeDraft)
        case 'delete':
          return remove(String(args[0]))
        case 'comment':
          return comment(String(args[0]), args[1] as PhoneComment)
        case 'getRecipe':
          return view(need(String(args[0])))
        case 'getFile':
          return getFile(String(args[0]), String(args[1] ?? ''), args[2] === undefined ? undefined : String(args[2]))
        case 'getDoc':
          return getDoc(String(args[0]))
        default:
          throw new Error(`Unknown request: ${method}`)
      }
    },
    shutdown() {
      for (const w of watchers.values()) w.close()
      for (const t of bumps.values()) clearTimeout(t)
    }
  }
}

function createPrompt(r: Saved): string {
  return [
    `Create a UI recipe in this folder: a working replica of a mobile app, and its documentation. Follow the ${SKILL} skill (.claude/skills/${SKILL}/SKILL.md).`,
    `<request>\n${r.prompt}\n</request>`,
    r.source
      ? `<source>\nThe user's existing app is in ${r.source}. Start from it: study its screens, components, navigation, copy, colors, typography, icons, images and animations, rebuild them in app/ as closely as you can, then apply the request. Only read that folder; never change, add or delete anything in it. Copy the assets you need (images, fonts, .riv files) into app/assets/.\n</source>`
      : '',
    'The user reviews the result full screen on their phone and comments on it from there, so make every screen, view and state reachable by its route. When the app works, write docs/RECIPE.md, capture every screen, view and state with capture_screens, and show the user the main screens with show_files.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function commentPrompt(r: Saved, c: PhoneComment, text: string, width: number, height: number, shotNote: string, errors: string[]): string {
  const t = c.target ?? { kind: 'view', selector: 'body', html: '', text: '' }
  const what = t.kind === 'view' ? 'the whole view' : 'one component'
  return [
    `The user commented on the Mobile UI recipe "${r.name}" from its preview on their phone. Change the recipe as they ask, following the ${SKILL} skill.`,
    `<comment>\n${text}\n</comment>`,
    [
      '<selection>',
      `They selected ${what}${t.name ? ` named "${t.name}"` : ''} at the route ${c.route || '#/'}, on a ${width}×${height} screen.`,
      `Selector: ${String(t.selector).slice(0, 300)}`,
      t.text ? `Text: ${String(t.text).slice(0, MAX_TEXT)}` : '',
      t.html ? `Markup:\n${String(t.html).slice(0, MAX_HTML)}` : '',
      '</selection>'
    ]
      .filter(Boolean)
      .join('\n'),
    shotNote,
    errors.length ? `The page reported these errors while loading: ${errors.join(' | ')}` : '',
    'Change only what the comment asks for, and keep routes and data-ui names stable. When the change works, update docs/RECIPE.md and recapture the screenshots of the screens and states you changed, so the documentation matches the recipe. The preview on the phone reloads by itself.'
  ]
    .filter(Boolean)
    .join('\n\n')
}
