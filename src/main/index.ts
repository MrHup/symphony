import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INVOKE_METHODS } from '@shared/api'
import type { MainEvent } from '@shared/types'
import { SymphonyCore } from './core'
import { electronAdapters, quitWhenAllWindowsClosed, repairPath, windowChrome } from './platform'
import { Remote } from './remote'
import { flushAll, setDataDir } from './store'

const CHARCOAL = '#131312'
const BONE = '#e9e5dc'

const here = fileURLToPath(new URL('.', import.meta.url))

// Lets test runs keep their graph and transcripts away from the real profile.
if (process.env.SYMPHONY_USER_DATA) app.setPath('userData', process.env.SYMPHONY_USER_DATA)

let win: BrowserWindow | null = null
let core: SymphonyCore | null = null
let remote: Remote | null = null

const toWindow = (e: MainEvent) => win?.webContents.send('symphony:event', e)

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: CHARCOAL,
    title: 'Symphony',
    ...windowChrome(CHARCOAL, BONE),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('focus', () => {
    core?.refreshOnFocus()
    remote?.focus()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  await repairPath()
  setDataDir(app.getPath('userData'))
  const adapters = electronAdapters(() => win)
  const c = new SymphonyCore(adapters)
  core = c
  c.on(toWindow)
  c.start()
  const r = new Remote(c, adapters, toWindow, app.getVersion())
  remote = r
  // Every request goes through remote orchestration, which runs it here or routes it to the machine that owns its target.
  for (const name of INVOKE_METHODS) {
    ipcMain.handle(`symphony:${name}`, (_e, ...args: unknown[]) => r.invoke(name, args))
  }
  // Paired machines are loaded before the window asks for its first snapshot.
  await r.start()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (quitWhenAllWindowsClosed) app.quit()
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  // Give the goodbye frames and pending writes a moment to go out before the process ends.
  e.preventDefault()
  remote?.shutdown()
  core?.shutdown()
  void Promise.all([flushAll(), new Promise((r) => setTimeout(r, 200))]).finally(() => app.quit())
})
