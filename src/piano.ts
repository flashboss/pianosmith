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
  const midi = note.midi
  const freq = 440 * 2 ** ((midi - 69) / 12)
  const dur = Math.max(0.08, note.end - note.start)
  const remaining = Math.max(0.05, dur - elapsed)
  const vel = Math.max(0.15, Math.min(1, note.velocity))
  // Register blend: 0 deep bass … 1 high treble.
  const bass = Math.max(0, Math.min(1, (55 - midi) / 28))
  const treble = Math.max(0, Math.min(1, (midi - 72) / 24))
  // Stretched partials (piano inharmonicity) — stronger in the bass.
  const B = 0.00012 + bass * 0.00055
  const partialAmps = [
    1.05 + bass * 0.55,
    0.48 - bass * 0.12,
    0.26 - bass * 0.08 + treble * 0.06,
    0.13 - bass * 0.05 + treble * 0.05,
    0.06 + treble * 0.05,
    0.03 + treble * 0.04,
    bass > 0.15 ? 0.09 * bass : 0,
    bass > 0.25 ? 0.05 * bass : 0,
  ]

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 0.55 + bass * 0.25
  const when = Math.max(startAt, ctx.currentTime)
  const bright = Math.min(7200, freq * (5.5 - bass * 2.2 + treble * 2.5))
  const dull = Math.max(90 + bass * 40, freq * (1.15 + treble * 0.5))
  filter.frequency.setValueAtTime(bright, when)
  filter.frequency.exponentialRampToValueAtTime(dull, when + Math.min(remaining, 1.8 + bass * 1.2))

  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.max(-0.55, Math.min(0.55, (midi - 60) / 36))
  filter.connect(pan)
  pan.connect(dest)

  const nodes: Array<AudioScheduledSourceNode> = []
  const release = Math.min(
    5.2,
    Math.max(remaining + 0.3 + bass * 0.9, 1.7 + bass * 1.6 - treble * 0.55 - (midi - 60) * 0.012),
  )
  const attackScale = elapsed > 0.02 ? 0.55 : 1
  const level = 0.16 + bass * 0.07

  for (let n = 1; n <= partialAmps.length; n++) {
    const amp = partialAmps[n - 1]
    if (amp < 0.01) continue
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    // Inharmonic partial: f * n * sqrt(1 + B n²)
    osc.frequency.value = freq * n * Math.sqrt(1 + B * n * n)
    const gain = ctx.createGain()
    const peak = Math.max(0.0002, vel * amp * level * attackScale)
    const end = when + release / Math.pow(n, 0.42 + bass * 0.12)
    const attack = 0.006 + bass * 0.012
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * (0.62 + bass * 0.12)), when + attack + 0.06)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(gain)
    gain.connect(filter)
    osc.start(when)
    osc.stop(end + 0.03)
    nodes.push(osc)
  }

  // Soft low “body” thump for bass notes (felt more than heard as click).
  if (elapsed < 0.02 && bass > 0.2) {
    const body = ctx.createOscillator()
    body.type = 'sine'
    body.frequency.value = Math.max(28, freq * 0.5)
    const bodyGain = ctx.createGain()
    const bodyPeak = vel * bass * 0.11 * attackScale
    bodyGain.gain.setValueAtTime(0.0001, when)
    bodyGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, bodyPeak), when + 0.012)
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18 + bass * 0.12)
    body.connect(bodyGain)
    bodyGain.connect(pan)
    body.start(when)
    body.stop(when + 0.35)
    nodes.push(body)
  }

  if (elapsed < 0.02) {
    const hammer = ctx.createBufferSource()
    hammer.buffer = noise
    const hammerFilter = ctx.createBiquadFilter()
    hammerFilter.type = bass > 0.35 ? 'bandpass' : 'highpass'
    hammerFilter.frequency.value = bass > 0.35 ? 180 + bass * 120 : 700 + treble * 900
    hammerFilter.Q.value = bass > 0.35 ? 0.7 : 0.5
    const hammerGain = ctx.createGain()
    hammerGain.gain.setValueAtTime(vel * (0.1 + treble * 0.1 - bass * 0.04), when)
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03 + bass * 0.025)
    hammer.connect(hammerFilter)
    hammerFilter.connect(hammerGain)
    hammerGain.connect(pan)
    hammer.start(when)
    hammer.stop(when + 0.06)
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
