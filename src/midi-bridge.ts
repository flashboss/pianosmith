import { serverBase } from './api'

export type BridgeRole = 'tv' | 'phone'
export type BridgeMidiHandler = (midi: number, on: boolean, velocity: number) => void

function wsOrHttpBase(): string {
  return serverBase().replace(/\/$/, '')
}

function sseUrl(room: string) {
  return `${wsOrHttpBase()}/api/midi/${encodeURIComponent(room)}/stream`
}

function postUrl(room: string) {
  return `${wsOrHttpBase()}/api/midi/${encodeURIComponent(room)}`
}

function keepAliveUrl(room: string) {
  return `${wsOrHttpBase()}/api/midi/${encodeURIComponent(room)}/keepalive`
}

function roomStatusUrl(room: string) {
  return `${wsOrHttpBase()}/api/midi/${encodeURIComponent(room)}`
}

/** TV listens for notes; phone publishes local Web MIDI to the room. */
export class MidiBridge {
  private source: EventSource | null = null
  private room = ''
  private onMidi: BridgeMidiHandler | null = null
  private onStatus: ((text: string) => void) | null = null
  private keepAliveTimer = 0
  private reconnectTimer = 0
  private wantListen = false
  private lastPingAt = 0
  listening = false

  setHandlers(onMidi: BridgeMidiHandler | null, onStatus: ((text: string) => void) | null = null) {
    this.onMidi = onMidi
    this.onStatus = onStatus
  }

  get code() {
    return this.room
  }

  async createRoom(): Promise<string> {
    const response = await fetch(`${wsOrHttpBase()}/api/midi/room`, { method: 'POST' })
    if (!response.ok) throw new Error('room')
    const body = (await response.json()) as { code?: string }
    if (!body.code) throw new Error('room')
    this.room = body.code
    return this.room
  }

  /** Phone: attach to an existing TV room (send-only, no SSE). */
  joinRoom(room: string) {
    this.stop()
    this.room = room.trim().toUpperCase()
    this.startKeepAlive()
  }

  /** TV: listen for notes from the phone. */
  listen(room: string) {
    this.stopStream()
    this.room = room.trim().toUpperCase()
    if (this.room.length < 4) return
    this.wantListen = true
    this.openStream()
    this.startKeepAlive()
  }

  private openStream() {
    if (!this.wantListen || !this.room) return
    this.stopStream(false)
    const source = new EventSource(sseUrl(this.room))
    this.source = source
    this.listening = true
    this.onStatus?.('listen')
    source.addEventListener('hello', () => this.onStatus?.('ready'))
    source.addEventListener('ping', () => {
      this.lastPingAt = Date.now()
      if (this.listening) this.onStatus?.('ready')
    })
    source.addEventListener('midi', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { t?: string; n?: number; v?: number }
        if (typeof data.n !== 'number') return
        this.onMidi?.(data.n, data.t !== 'off', data.v ?? 100)
      } catch {
        /* ignore */
      }
    })
    source.onerror = () => {
      this.onStatus?.('error')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (!this.wantListen || this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0
      if (!this.wantListen) return
      this.openStream()
    }, 2000)
  }

  private startKeepAlive() {
    this.stopKeepAlive()
    if (!this.room) return
    const beat = () => {
      if (!this.room) return
      void fetch(keepAliveUrl(this.room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => undefined)
      // Host: if SSE went quiet, force a reconnect even when EventSource is sticky-broken.
      if (this.wantListen && this.lastPingAt && Date.now() - this.lastPingAt > 25_000) {
        this.scheduleReconnect()
      }
    }
    beat()
    this.keepAliveTimer = window.setInterval(beat, 12_000)
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      window.clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = 0
    }
  }

  private stopStream(clearWant = true) {
    if (clearWant) this.wantListen = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = 0
    }
    this.source?.close()
    this.source = null
    this.listening = false
  }

  async send(midi: number, on: boolean, velocity = 100) {
    if (!this.room) return
    try {
      const response = await fetch(postUrl(this.room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: on ? 'on' : 'off', n: midi, v: velocity }),
        keepalive: true,
      })
      if (response.status === 503) this.onStatus?.('error')
    } catch {
      /* ignore */
    }
  }

  /** Optional probe used by UI diagnostics. */
  async listeners(): Promise<number | null> {
    if (!this.room) return null
    try {
      const response = await fetch(roomStatusUrl(this.room))
      if (!response.ok) return null
      const body = (await response.json()) as { listeners?: number }
      return typeof body.listeners === 'number' ? body.listeners : null
    } catch {
      return null
    }
  }

  stop() {
    this.stopStream(true)
    this.stopKeepAlive()
    this.lastPingAt = 0
    this.room = ''
  }
}
