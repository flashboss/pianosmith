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

/** TV listens for notes; phone publishes local Web MIDI to the room. */
export class MidiBridge {
  private source: EventSource | null = null
  private room = ''
  private onMidi: BridgeMidiHandler | null = null
  private onStatus: ((text: string) => void) | null = null
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
  }

  /** TV: listen for notes from the phone. */
  listen(room: string) {
    this.stop()
    this.room = room.trim().toUpperCase()
    if (this.room.length < 4) return
    const source = new EventSource(sseUrl(this.room))
    this.source = source
    this.listening = true
    this.onStatus?.('listen')
    source.addEventListener('hello', () => this.onStatus?.('ready'))
    source.addEventListener('midi', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { t?: string; n?: number; v?: number }
        if (typeof data.n !== 'number') return
        this.onMidi?.(data.n, data.t !== 'off', data.v ?? 100)
      } catch {
        /* ignore */
      }
    })
    source.onerror = () => this.onStatus?.('error')
  }

  async send(midi: number, on: boolean, velocity = 100) {
    if (!this.room) return
    try {
      await fetch(postUrl(this.room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: on ? 'on' : 'off', n: midi, v: velocity }),
        keepalive: true,
      })
    } catch {
      /* ignore */
    }
  }

  stop() {
    this.source?.close()
    this.source = null
    this.listening = false
  }
}
