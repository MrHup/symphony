import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { INVOKE_METHODS, type SymphonyBridge } from '@shared/api'
import type { MainEvent } from '@shared/types'

const bridge: Record<string, unknown> = {
  onEvent(cb: (e: MainEvent) => void) {
    const listener = (_: unknown, e: MainEvent) => cb(e)
    ipcRenderer.on('symphony:event', listener)
    return () => ipcRenderer.removeListener('symphony:event', listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform
}
for (const method of INVOKE_METHODS) {
  bridge[method] = (...args: unknown[]) => ipcRenderer.invoke(`symphony:${method}`, ...args)
}

contextBridge.exposeInMainWorld('symphony', bridge as unknown as SymphonyBridge)
