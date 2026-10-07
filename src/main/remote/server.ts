// The remote machine's side of a link: numbers its events, runs the orchestrator's requests, and
// remembers each result for five minutes by request id, so a request resent after a reconnect
// runs only once. Plain logic over a `send` function, so it can be tested without sockets.
import { DEDUPE_MS, MAX_FRAME_BYTES, type Frame } from '@shared/remote'
import type { AppSnapshot, MainEvent } from '@shared/types'

export class LinkServer {
  /** The last event number sent. */
  seq = 0
  private done = new Map<string, { frame: Frame; at: number }>()
  private running = new Set<string>()

  constructor(
    private exec: (method: string, args: unknown[]) => Promise<unknown>,
    /** Sends on the current link; a no-op while there is none (the orchestrator resends later). */
    private send: (f: Frame) => void,
    private now: () => number = Date.now
  ) {}

  event(event: MainEvent): void {
    this.seq += 1
    this.send({ t: 'event', seq: this.seq, event })
  }

  snapshot(snapshot: AppSnapshot): void {
    this.send({ t: 'snapshot', snapshot, seq: this.seq })
  }

  async invoke(f: { id: string; method: string; args: unknown[] }): Promise<void> {
    this.expire()
    const done = this.done.get(f.id)
    if (done) return this.send(done.frame)
    // Already running: its result goes out on whatever link is up when it finishes.
    if (this.running.has(f.id)) return
    this.running.add(f.id)
    let frame: Frame
    try {
      const value = await this.exec(f.method, f.args)
      // `seq` is read in the same tick the value is sent, so it is the last event the value reflects.
      frame = { t: 'result', id: f.id, ok: true, value, seq: this.seq }
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) frame = { t: 'result', id: f.id, ok: false, error: 'The reply is too large to send (over 32 MB).' }
    } catch (err) {
      frame = { t: 'result', id: f.id, ok: false, error: (err as Error).message }
    }
    this.running.delete(f.id)
    this.done.set(f.id, { frame, at: this.now() })
    this.send(frame)
  }

  private expire(): void {
    const cutoff = this.now() - DEDUPE_MS
    for (const [id, d] of this.done) {
      if (d.at >= cutoff) break
      this.done.delete(id)
    }
  }
}
