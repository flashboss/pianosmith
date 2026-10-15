import { t } from './i18n'

const MIN_LOOP = 0.35

export class Player {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  private source: AudioBufferSourceNode | null = null
  private token = 0
  private startedAt = 0
  private offset = 0
  buffer: AudioBuffer | null = null
  playing = false
  rate = 1
  muted = false
  loop = false
  /** Practice loop start (seconds). Null = beginning of song. */
  loopStart: number | null = null
  /** Practice loop end (seconds). Null = end of song. */
  loopEnd: number | null = null
  onChange: (() => void) | null = null

  private ensureGraph() {
    if (this.ctx) return
    const ctx = new AudioContext()
    const master = ctx.createGain()
    master.gain.value = this.muted ? 0 : 1
    const streamDest = ctx.createMediaStreamDestination()
    master.connect(ctx.destination)
    master.connect(streamDest)
    this.ctx = ctx
    this.master = master
    this.streamDest = streamDest
  }

  setMuted(muted: boolean) {
    this.muted = muted
    this.ensureGraph()
    if (this.master) this.master.gain.value = muted ? 0 : 1
    this.onChange?.()
  }

  setLoop(loop: boolean) {
    this.loop = loop
    this.onChange?.()
  }

  effectiveLoopStart(): number {
    if (this.loopStart == null) return 0
    return Math.max(0, Math.min(this.loopStart, Math.max(0, this.duration - MIN_LOOP)))
  }

  effectiveLoopEnd(): number {
    const start = this.effectiveLoopStart()
    const fallBack = this.duration
    if (this.loopEnd == null) return Math.max(start + MIN_LOOP, fallBack)
    return Math.max(start + MIN_LOOP, Math.min(this.loopEnd, fallBack))
  }

  hasLoopRange(): boolean {
    return this.loopStart != null || this.loopEnd != null
  }

  setLoopStart(time: number | null) {
    if (time == null) {
      this.loopStart = null
    } else {
      const end = this.loopEnd ?? this.duration
      this.loopStart = Math.max(0, Math.min(time, Math.max(0, end - MIN_LOOP)))
    }
    this.onChange?.()
  }

  setLoopEnd(time: number | null) {
    if (time == null) {
      this.loopEnd = null
    } else {
      const start = this.loopStart ?? 0
      this.loopEnd = Math.max(start + MIN_LOOP, Math.min(time, this.duration))
    }
    this.onChange?.()
  }

  clearLoopRange() {
    this.loopStart = null
    this.loopEnd = null
    this.onChange?.()
  }

  async resume() {
    this.ensureGraph()
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume()
  }

  get currentTime(): number {
    if (!this.playing || !this.ctx) return this.offset
    return this.offset + (this.ctx.currentTime - this.startedAt) * this.rate
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    await this.resume()
    if (!this.ctx) throw new Error(t('audioUnavailable'))
    try {
      return await this.ctx.decodeAudioData(data.slice(0))
    } catch {
      throw new Error(t('audioFormatUnsupported'))
    }
  }

  audioTrack(): MediaStreamTrack {
    this.ensureGraph()
    const track = this.streamDest?.stream.getAudioTracks()[0]
    if (!track) throw new Error(t('audioUnavailable'))
    return track
  }

  private stopSource() {
    this.token++
    const source = this.source
    this.source = null
    if (!source) return
    try {
      source.onended = null
      source.stop()
    } catch {
      /* already stopped */
    }
    try {
      source.disconnect()
    } catch {
      /* already disconnected */
    }
  }

  async play() {
    if (!this.buffer) return
    await this.resume()
    if (!this.ctx || !this.master) return

    if (this.loop) {
      const start = this.effectiveLoopStart()
      const end = this.effectiveLoopEnd()
      if (this.offset < start || this.offset >= end - 0.02) this.offset = start
    } else if (this.offset >= this.buffer.duration - 0.05) {
      this.offset = 0
    }

    this.stopSource()
    const my = ++this.token
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.playbackRate.value = this.rate
    source.connect(this.master)

    const playOffset = this.offset
    const slice =
      this.loop && this.duration > 0
        ? Math.max(MIN_LOOP, this.effectiveLoopEnd() - playOffset)
        : undefined

    source.onended = () => {
      if (my !== this.token) return
      this.source = null
      if (this.loop) {
        this.offset = this.effectiveLoopStart()
        this.playing = false
        void this.play()
        return
      }
      this.playing = false
      this.offset = this.duration
      this.onChange?.()
    }
    this.source = source
    this.startedAt = this.ctx.currentTime
    this.playing = true
    if (slice != null) source.start(0, playOffset, slice)
    else source.start(0, playOffset)
    this.onChange?.()
  }

  pause() {
    if (!this.playing) return
    const time = this.currentTime
    this.playing = false
    this.offset = time
    this.stopSource()
    this.onChange?.()
  }

  async toggle() {
    if (this.playing) this.pause()
    else await this.play()
  }

  async seek(time: number) {
    const was = this.playing
    let next = Math.max(0, Math.min(time, Math.max(0, this.duration - 0.01)))
    if (this.loop && this.duration > 0) {
      const start = this.effectiveLoopStart()
      const end = this.effectiveLoopEnd()
      next = Math.max(start, Math.min(next, end - 0.01))
    }
    this.playing = false
    this.stopSource()
    this.offset = next
    if (was) await this.play()
    else this.onChange?.()
  }

  async seekBy(delta: number) {
    await this.seek(this.currentTime + delta)
  }

  async setRate(rate: number) {
    const time = this.currentTime
    const was = this.playing
    this.playing = false
    this.stopSource()
    this.rate = rate
    this.offset = time
    if (was) await this.play()
    else this.onChange?.()
  }
}
