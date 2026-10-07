import type { SymphonyBridge } from '../shared/api'

declare global {
  interface Window {
    symphony: SymphonyBridge
  }
}

export {}
