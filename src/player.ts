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
  onChange: (() => void) | null = null

  private ensureGraph() {
    if (this.ctx) return
    const ctx = new AudioContext()
    const master = ctx.createGain()
    master.gain.value = 1
    const streamDest = ctx.createMediaStreamDestination()
    master.connect(ctx.destination)
    master.connect(streamDest)
    this.ctx = ctx
    this.master = master
    this.streamDest = streamDest
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
    if (!this.ctx) throw new Error('Audio non disponibile')
    try {
      return await this.ctx.decodeAudioData(data.slice(0))
    } catch {
      throw new Error('Formato audio non supportato. Prova MP3, WAV o M4A.')
    }
  }

  audioTrack(): MediaStreamTrack {
    this.ensureGraph()
    const track = this.streamDest?.stream.getAudioTracks()[0]
    if (!track) throw new Error('Audio non disponibile')
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
    if (this.offset >= this.buffer.duration - 0.05) this.offset = 0
    this.stopSource()
    const my = ++this.token
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.playbackRate.value = this.rate
    source.connect(this.master)
    source.onended = () => {
      if (my !== this.token) return
      this.playing = false
      this.offset = this.duration
      this.source = null
      this.onChange?.()
    }
    this.source = source
    this.startedAt = this.ctx.currentTime
    this.playing = true
    source.start(0, this.offset)
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
    const next = Math.max(0, Math.min(time, Math.max(0, this.duration - 0.01)))
    this.playing = false
    this.stopSource()
    this.offset = next
    if (was) await this.play()
    else this.onChange?.()
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
