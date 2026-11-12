export type MidiHandler = (midi: number, on: boolean, velocity: number) => void

type MidiAccessLike = {
  inputs: Map<string, { onmidimessage: ((event: { data: Uint8Array }) => void) | null }>
  onstatechange: (() => void) | null
}

/** Local Web MIDI (phone/desktop) + optional remote note injection (TV via bridge). */
export class MidiInput {
  private handler: MidiHandler | null = null
  private access: MidiAccessLike | null = null
  private supported = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
  private wired = false

  onNotes(handler: MidiHandler | null) {
    this.handler = handler
  }

  get hasWebMidi() {
    return this.supported
  }

  get connected() {
    return Boolean(this.access && this.access.inputs.size > 0)
  }

  async start(): Promise<'ok' | 'unsupported' | 'denied'> {
    if (!this.supported) return 'unsupported'
    if (this.wired && this.access) {
      this.bindInputs()
      return 'ok'
    }
    try {
      const access = (await navigator.requestMIDIAccess({ sysex: false })) as unknown as MidiAccessLike
      this.access = access
      access.onstatechange = () => this.bindInputs()
      this.bindInputs()
      this.wired = true
      return 'ok'
    } catch {
      return 'denied'
    }
  }

  stop() {
    if (this.access) {
      for (const input of this.access.inputs.values()) input.onmidimessage = null
      this.access.onstatechange = null
    }
    this.access = null
    this.wired = false
  }

  /** Inject a note from the LAN bridge (or tests). */
  inject(midi: number, on: boolean, velocity = 100) {
    const n = Math.round(midi)
    if (!Number.isFinite(n) || n < 0 || n > 127) return
    this.handler?.(n, on, Math.max(0, Math.min(127, Math.round(velocity))))
  }

  private bindInputs() {
    if (!this.access) return
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (event) => {
        const data = event.data
        if (!data || data.length < 2) return
        const status = data[0] & 0xf0
        const midi = data[1]
        const velocity = data.length > 2 ? data[2] : 0
        if (status === 0x90) this.inject(midi, velocity > 0, velocity || 100)
        else if (status === 0x80) this.inject(midi, false, velocity)
      }
    }
  }
}
