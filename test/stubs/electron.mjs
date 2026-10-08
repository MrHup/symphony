// Just enough of Electron for the remote-orchestration modules to run under plain Node in tests.
export const app = { getPath: () => '', getVersion: () => '0.1.0' }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined }
export const systemPreferences = { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString()
}
export const powerMonitor = { isOnBatteryPower: () => false, on: () => undefined }
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createThumbnailFromPath: async () => ({ isEmpty: () => true }) }
export const powerSaveBlocker = { start: () => 1, stop: () => undefined }
export default { app, dialog, shell, systemPreferences, safeStorage, powerMonitor, powerSaveBlocker, nativeImage }
