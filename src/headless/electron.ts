// The parts of Electron that platform.ts reaches on a remote machine, in plain Node, for the headless
// client. scripts/headless.mjs bundles this module in place of 'electron'. Only the remote path is
// covered: the device key and the power state. The window's features (dialogs, shell, images,
// microphone) do not exist here; the headless adapters never call them, and touching one throws.

/**
 * Plain Node cannot reach the OS keychain, so the device key is kept as it is, the way SSH keeps its
 * keys: the headless data folder is created readable by this user only (src/headless/index.ts).
 */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text, 'utf8'),
  decryptString: (data: Buffer) => data.toString('utf8')
}

/** No power events without Electron: after a sleep the link notices the silence and redials. */
export const powerMonitor = {
  isOnBatteryPower: () => false,
  on: () => powerMonitor
}

/** Idle sleep is left to the OS settings; a headless machine is usually set never to sleep. */
export const powerSaveBlocker = {
  start: () => 0,
  stop: () => undefined
}

const missing = (name: string) =>
  new Proxy(
    {},
    {
      get: (_, key) => {
        throw new Error(`${name}.${String(key)} needs Electron and is not available on a headless machine.`)
      }
    }
  )

export const dialog = missing('dialog')
export const shell = missing('shell')
export const nativeImage = missing('nativeImage')
export const systemPreferences = missing('systemPreferences')
