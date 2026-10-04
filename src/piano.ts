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

function strike(
  ctx: BaseAudioContext,
  dest: AudioNode,
  noise: AudioBuffer,
  note: RawNote,
) {
  const freq = 440 * 2 ** ((note.midi - 69) / 12)
  const time = Math.max(0, note.start)
  const dur = Math.max(0.08, note.end - note.start)
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
  filter.frequency.setValueAtTime(Math.min(9000, freq * 8), time)
  filter.frequency.exponentialRampToValueAtTime(Math.max(180, freq * 1.4), time + Math.min(dur, 1.4))

  const pan = ctx.createStereoPanner()
  pan.pan.value = Math.max(-0.55, Math.min(0.55, (note.midi - 60) / 36))
  filter.connect(pan)
  pan.connect(dest)

  const release = Math.min(3.4, Math.max(dur + 0.25, 1.55 - (note.midi - 60) * 0.018))
  for (const [mult, amp] of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq * mult
    const gain = ctx.createGain()
    const peak = Math.max(0.0002, vel * amp * 0.18)
    const end = time + release / Math.sqrt(mult)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.008)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.55), time + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(gain)
    gain.connect(filter)
    osc.start(time)
    osc.stop(end + 0.02)
  }

  const hammer = ctx.createBufferSource()
  hammer.buffer = noise
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 900
  const hammerGain = ctx.createGain()
  hammerGain.gain.setValueAtTime(vel * 0.18, time)
  hammerGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035)
  hammer.connect(highpass)
  highpass.connect(hammerGain)
  hammerGain.connect(pan)
  hammer.start(time)
  hammer.stop(time + 0.05)
}

export async function renderPiano(notes: RawNote[]): Promise<AudioBuffer> {
  if (notes.length === 0) throw new Error('Nessuna nota da suonare')
  const end = notes.reduce((max, note) => Math.max(max, note.end), 0) + 2
  const ctx = new OfflineAudioContext(2, Math.ceil(end * 44100), 44100)
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -16
  comp.knee.value = 18
  comp.ratio.value = 4
  comp.attack.value = 0.004
  comp.release.value = 0.22
  const master = ctx.createGain()
  master.gain.value = 0.9
  comp.connect(master)
  master.connect(ctx.destination)
  const noise = noiseBuffer(ctx)
  for (const note of notes) strike(ctx, comp, noise, note)
  return ctx.startRendering()
}
