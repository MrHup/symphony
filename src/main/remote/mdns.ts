// Finding the orchestrator on the local network: it advertises itself over mDNS (Bonjour) while
// remote orchestration is on, and remote machines browse for it. Entering an address is the fallback.
import { Bonjour, type Service } from 'bonjour-service'
import { MDNS_TYPE, PROTOCOL } from '@shared/remote'
import type { DiscoveredOrchestrator } from '@shared/types'

/** Advertise this orchestrator; returns a function that stops advertising. */
export function advertise(opts: { id: string; name: string; port: number }): () => void {
  // Loopback test runs stay off the network.
  if (process.env.SYMPHONY_REMOTE_LOOPBACK) return () => undefined
  let bonjour: Bonjour | null = null
  try {
    bonjour = new Bonjour({}, (err: Error) => console.error('[mdns]', err.message))
    const service = bonjour.publish({ name: `Symphony ${opts.name} ${opts.id.slice(0, 6)}`, type: MDNS_TYPE, port: opts.port, txt: { id: opts.id, name: opts.name, p: String(PROTOCOL) } })
    service.on('error', (err: Error) => console.error('[mdns] publish', err.message))
  } catch (err) {
    console.error('[mdns] advertise failed', err)
  }
  return () => {
    try {
      bonjour?.unpublishAll(() => bonjour?.destroy())
    } catch {
      // already gone
    }
  }
}

/** Browse for orchestrators; `onChange` gets the current list. Returns a function that stops browsing. */
export function browse(onChange: (list: DiscoveredOrchestrator[]) => void): () => void {
  if (process.env.SYMPHONY_REMOTE_LOOPBACK) return () => undefined
  const found = new Map<string, DiscoveredOrchestrator>()
  let bonjour: Bonjour | null = null
  let timer: NodeJS.Timeout | undefined
  const toEntry = (s: Service): DiscoveredOrchestrator | null => {
    const txt = (s.txt ?? {}) as Record<string, string>
    const host = s.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.referer?.address
    return txt.id && host ? { id: String(txt.id), name: String(txt.name ?? s.name), host, port: s.port } : null
  }
  try {
    bonjour = new Bonjour({}, (err: Error) => console.error('[mdns]', err.message))
    const browser = bonjour.find({ type: MDNS_TYPE })
    browser.on('up', (s) => {
      const e = toEntry(s)
      if (!e) return
      found.set(e.id, e)
      onChange([...found.values()])
    })
    browser.on('down', (s) => {
      const id = (s.txt as Record<string, string> | undefined)?.id
      if (id && found.delete(String(id))) onChange([...found.values()])
    })
    // Ask again now and then: a service that appeared while a packet was lost would otherwise stay unseen.
    timer = setInterval(() => browser.update(), 30_000)
  } catch (err) {
    console.error('[mdns] browse failed', err)
  }
  return () => {
    clearInterval(timer)
    try {
      bonjour?.destroy()
    } catch {
      // already gone
    }
  }
}
