import type { RawNote } from './types'

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.05)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2
  }
  return buffer
}

/** Song duration covering all notes, with a short tail for releases. */
export function notesDuration(notes: RawNote[]): number {
  if (notes.length === 0) return 0
  return notes.reduce((max, note) => Math.max(max, note.end), 0) + 0.75
}

export function makeSilentBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(Math.max(0.05, seconds) * ctx.sampleRate))
  return ctx.createBuffer(1, length, ctx.sampleRate)
}

type Voice = {
  stop: (when?: number) => void
}

/**
 * Schedule one piano strike at an absolute AudioContext time.
 * `elapsed` is how far into the note we already are (seek into a sounding note).
 */
function scheduleStrike(
  ctx: AudioContext,
  dest: AudioNode,
  noise: AudioBuffer,
  note: RawNote,
  startAt: number,
  elapsed = 0,
): Voice {
  const freq = 440 * 2 ** ((note.midi - 69) / 12)
  const dur = Math.max(0.08, note.end - note.start)
  const remaining = Math.max(0.05, dur - elapsed)
  const vel = Math.max(0.15, Math.min(1, note.velocity))
  const partials: Array<[number, number]> = [
    [1, 1],
    [2, 0.52],
    [3, 0.28],
    [4, 0.14],
    [5, 0.07],
    [6, 0.035],
  ]

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 0.6
  const when = Math.max(startAt, ctx.currentTime)
  filter.frequency.setValueAtTime(Math.min(9000, freq * 8), when)
  filter.frequency.exponentialRampToValueAtTime(Math.max(180, freq * 1.4), when + Math.min(remaining, 1.4))

  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.max(-0.55, Math.min(0.55, (note.midi - 60) / 36))
  filter.connect(pan)
  pan.connect(dest)

  const nodes: Array<AudioScheduledSourceNode> = []
  const release = Math.min(3.4, Math.max(remaining + 0.25, 1.55 - (note.midi - 60) * 0.018))
  const attackScale = elapsed > 0.02 ? 0.55 : 1

  for (const [mult, amp] of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq * mult
    const gain = ctx.createGain()
    const peak = Math.max(0.0002, vel * amp * 0.18 * attackScale)
    const end = when + release / Math.sqrt(mult)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.008)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.55), when + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(gain)
    gain.connect(filter)
    osc.start(when)
    osc.stop(end + 0.02)
    nodes.push(osc)
  }

  if (elapsed < 0.02) {
    const hammer = ctx.createBufferSource()
    hammer.buffer = noise
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 900
    const hammerGain = ctx.createGain()
    hammerGain.gain.setValueAtTime(vel * 0.18, when)
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035)
    hammer.connect(highpass)
    highpass.connect(hammerGain)
    hammerGain.connect(pan)
    hammer.start(when)
    hammer.stop(when + 0.05)
    nodes.push(hammer)
  }

  return {
    stop: (at?: number) => {
      const stopAt = at ?? ctx.currentTime
      for (const node of nodes) {
        try {
          node.stop(stopAt)
        } catch {
          /* already stopped */
        }
      }
      try {
        filter.disconnect()
        pan.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/** Live note-by-note piano driven by song transport time. */
export class LivePiano {
  private notes: RawNote[] = []
  private nextIndex = 0
  private voices: Voice[] = []
  private noise: AudioBuffer | null = null
  private lookAhead = 0.28

  setNotes(notes: RawNote[]) {
    this.stopAll()
    this.notes = [...notes].sort((a, b) => a.start - b.start || a.end - b.end)
    this.nextIndex = 0
  }

  clear() {
    this.stopAll()
    this.notes = []
    this.nextIndex = 0
  }

  stopAll() {
    for (const voice of this.voices) voice.stop()
    this.voices = []
  }

  /**
   * Reset scheduling for a seek, starting notes already sounding at `songTime`
   * when playback is active.
   */
  seek(
    ctx: AudioContext,
    dest: AudioNode,
    songTime: number,
    songToCtx: (songSeconds: number) => number,
    playing: boolean,
  ) {
    this.stopAll()
    this.nextIndex = 0
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].end <= songTime) {
      this.nextIndex += 1
    }
    if (!playing) return
    let i = this.nextIndex
    while (i < this.notes.length && this.notes[i].start < songTime + 0.001) {
      const note = this.notes[i]
      if (note.end > songTime) {
        const elapsed = Math.max(0, songTime - note.start)
        this.voices.push(scheduleStrike(ctx, dest, this.ensureNoise(ctx), note, ctx.currentTime, elapsed))
      }
      i += 1
    }
    this.nextIndex = i
    this.scheduleAhead(ctx, dest, songTime, songToCtx)
  }

  /** Schedule upcoming notes; call periodically while playing. */
  tick(
    ctx: AudioContext,
    dest: AudioNode,
    songTime: number,
    songToCtx: (songSeconds: number) => number,
    playing: boolean,
  ) {
    if (!playing) return
    this.scheduleAhead(ctx, dest, songTime, songToCtx)
  }

  private ensureNoise(ctx: AudioContext): AudioBuffer {
    if (!this.noise || this.noise.sampleRate !== ctx.sampleRate) this.noise = noiseBuffer(ctx)
    return this.noise
  }

  private scheduleAhead(
    ctx: AudioContext,
    dest: AudioNode,
    songTime: number,
    songToCtx: (songSeconds: number) => number,
  ) {
    const until = songTime + this.lookAhead
    const noise = this.ensureNoise(ctx)
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].start <= until) {
      const note = this.notes[this.nextIndex]
      this.nextIndex += 1
      if (note.end <= songTime) continue
      const elapsed = note.start < songTime ? songTime - note.start : 0
      const when = note.start < songTime ? ctx.currentTime : songToCtx(note.start)
      if (when < ctx.currentTime - 0.05) continue
      this.voices.push(scheduleStrike(ctx, dest, noise, note, when, elapsed))
    }
    if (this.voices.length > 80) this.voices = this.voices.slice(-40)
  }
}
