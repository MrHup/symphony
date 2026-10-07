// One link's WebSocket: JSON frames, the frame size cap, ping/pong every 10 s, and the rule that
// 30 s of silence counts as offline. Used by both sides.
import type WebSocket from 'ws'
import { MAX_FRAME_BYTES, PING_MS, SILENCE_MS, type ByeReason, type Frame } from '@shared/remote'

export class Wire {
  private lastHeard = Date.now()
  private timer: NodeJS.Timeout
  private closed = false

  constructor(
    private ws: WebSocket,
    onFrame: (f: Frame) => void,
    /** Called once, however the link ended. `bye` is set when the other side said goodbye. */
    private onClose: (bye: ByeReason | null) => void
  ) {
    let bye: ByeReason | null = null
    ws.on('message', (data) => {
      this.lastHeard = Date.now()
      let frame: Frame
      try {
        frame = JSON.parse(String(data)) as Frame
      } catch {
        return
      }
      if (frame.t === 'ping') return void this.send({ t: 'pong' })
      if (frame.t === 'pong') return
      if (frame.t === 'bye') bye = frame.reason
      onFrame(frame)
    })
    ws.on('close', () => this.finish(bye))
    ws.on('error', () => this.finish(bye))
    this.timer = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_MS) {
        ws.terminate()
        return this.finish(bye)
      }
      this.send({ t: 'ping' })
    }, PING_MS)
  }

  get open(): boolean {
    return !this.closed
  }

  /** Bytes queued but not yet sent; terminal output waits while this is high. */
  get buffered(): number {
    return this.ws.bufferedAmount
  }

  /** False when the link is closed or the frame is over the size cap (nothing is sent then). */
  send(frame: Frame): boolean {
    if (this.closed) return false
    const text = JSON.stringify(frame)
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return false
    this.ws.send(text)
    return true
  }

  /** End the link on purpose; with a reason, the other side learns why. */
  close(reason?: ByeReason): void {
    if (this.closed) return
    if (reason) this.send({ t: 'bye', reason })
    this.ws.close()
    this.finish(null)
  }

  private finish(bye: ByeReason | null): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.onClose(bye)
  }
}
