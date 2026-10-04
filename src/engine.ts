import type { NoteEvent } from './types'
import { clampMidi, isBlack, noteLabel, rgba, whiteIndex } from './theory'

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  color: [number, number, number]
}

interface Finger {
  x: number
  y: number
  pressed: number
  midi: number
}

interface HandState {
  side: 'left' | 'right'
  home: number
  palmX: number
  ready: boolean
  fingers: Finger[]
}

interface Layout {
  whiteW: number
  centerX: (midi: number) => number
}

const LOOKAHEAD = 3.15

function makeHand(side: 'left' | 'right'): HandState {
  return {
    side,
    home: side === 'left' ? 50 : 72,
    palmX: 0,
    ready: false,
    fingers: Array.from({ length: 5 }, () => ({ x: 0, y: 0, pressed: 0, midi: 60 })),
  }
}

function pickSpread(values: number[], count: number): number[] {
  if (values.length <= count) return values
  const picked: number[] = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (values.length - 1)) / (count - 1))
    const value = values[idx]
    if (picked[picked.length - 1] !== value) picked.push(value)
  }
  return picked
}

function fingerMidis(side: 'left' | 'right', active: number[], home: number): number[] {
  const unique = [...new Set(active)].sort((a, b) => a - b)
  const chosen = pickSpread(unique, 5)
  if (chosen.length === 0) {
    return [-4, -2, 0, 2, 4].map((offset) => clampMidi(home + (side === 'right' ? offset : -offset)))
  }
  if (chosen.length === 1) {
    const midi = chosen[0]
    const step = side === 'right' ? 1 : -1
    return [0, 1, 2, 3, 4].map((finger) => clampMidi(midi + (finger - 2) * 2 * step))
  }
  const order = side === 'right' ? chosen : [...chosen].reverse()
  const result = [0, 1, 2, 3, 4].map((finger) => {
    const idx = (finger * (order.length - 1)) / 4
    const i0 = Math.floor(idx)
    const i1 = Math.min(order.length - 1, i0 + 1)
    return order[i0] + (order[i1] - order[i0]) * (idx - i0)
  })
  const used = new Set<number>()
  for (const midi of order) {
    let best = 0
    let bestDist = Infinity
    for (let finger = 0; finger < 5; finger++) {
      if (used.has(finger)) continue
      const dist = Math.abs(result[finger] - midi)
      if (dist < bestDist) {
        bestDist = dist
        best = finger
      }
    }
    result[best] = midi
    used.add(best)
  }
  return result.map((midi) => clampMidi(midi))
}

function traceRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function fillFinger(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
) {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const px = -dy / len
  const py = dx / len
  const radius0 = Math.max(2, r0)
  const radius1 = Math.max(2, r1)
  ctx.beginPath()
  ctx.moveTo(x0 + px * radius0, y0 + py * radius0)
  ctx.lineTo(x1 + px * radius1, y1 + py * radius1)
  ctx.lineTo(x1 - px * radius1, y1 - py * radius1)
  ctx.lineTo(x0 - px * radius0, y0 - py * radius0)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x0, y0, radius0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x1, y1, radius1, 0, Math.PI * 2)
  ctx.fill()
}

export class Visualizer {
  private notes: NoteEvent[] | null = null
  private title = ''
  private showNames = false
  private w = 1280
  private h = 720
  private keyboardTop = 500
  private camLo = 10
  private camHi = 28
  private camReady = false
  private prev = -1
  private sparks: Spark[] = []
  private left = makeHand('left')
  private right = makeHand('right')

  constructor(private ctx: CanvasRenderingContext2D) {}

  setViewport(w: number, h: number) {
    this.w = w
    this.h = h
    this.keyboardTop = h * 0.72
  }

  setShowNames(show: boolean) {
    this.showNames = show
  }

  setTitle(title: string) {
    this.title = title
  }

  setNotes(notes: NoteEvent[] | null) {
    this.notes = notes
    this.prev = -1
    this.camReady = false
    this.sparks = []
    this.left.ready = false
    this.right.ready = false
    if (notes) {
      for (const note of notes) note.hit = false
    }
  }

  render(time: number, dt: number) {
    const step = Math.max(0.001, Math.min(0.05, dt))
    if (this.prev < 0) this.prev = time
    if (time < this.prev - 0.04 && this.notes) {
      for (const note of this.notes) {
        if (note.start > time - 0.02) note.hit = false
      }
    }

    this.frameCamera(time, step)
    const layout = this.layout()
    this.separateHands()
    this.updateHand(this.left, time, step, layout)
    this.updateHand(this.right, time, step, layout)
    this.syncSparks(time, step, layout)

    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, this.w, this.h)

    const active = this.activeNotes(time)
    this.drawNotes(time, layout)
    this.drawKeyboard(layout, active)
    this.drawFire(layout, active)
    this.drawSparks(step)
    this.drawHand(this.left, layout.whiteW)
    this.drawHand(this.right, layout.whiteW)
    this.drawTitle(time)
    this.prev = time
  }

  private layout(): Layout {
    const span = Math.max(10, this.camHi - this.camLo)
    const whiteW = this.w / span
    const centerX = (midi: number) => {
      if (!isBlack(midi)) {
        const index = whiteIndex(midi)
        return (index - this.camLo) * whiteW + whiteW / 2
      }
      const left = whiteIndex(midi - 1)
      const right = whiteIndex(midi + 1)
      const leftX = (left - this.camLo) * whiteW + whiteW / 2
      const rightX = (right - this.camLo) * whiteW + whiteW / 2
      return (leftX + rightX) / 2
    }
    return { whiteW, centerX }
  }

  private frameCamera(time: number, dt: number) {
    let minMidi = 127
    let maxMidi = 0
    let any = false
    if (this.notes) {
      for (const note of this.notes) {
        if (note.end < time - 0.35 || note.start > time + LOOKAHEAD + 0.2) continue
        any = true
        minMidi = Math.min(minMidi, note.midi)
        maxMidi = Math.max(maxMidi, note.midi)
      }
    }
    let lo: number
    let hi: number
    if (!any) {
      lo = whiteIndex(43) - 1
      hi = whiteIndex(84) + 2
    } else {
      const low = isBlack(minMidi) ? minMidi - 1 : minMidi
      const high = isBlack(maxMidi) ? maxMidi + 1 : maxMidi
      lo = whiteIndex(low) - 2
      hi = whiteIndex(high) + 3
      if (hi - lo < 15) {
        const mid = (hi + lo) / 2
        lo = mid - 7.5
        hi = mid + 7.5
      }
    }
    lo = Math.max(-0.5, lo)
    hi = Math.min(52.5, Math.max(lo + 12, hi))
    if (!this.camReady) {
      this.camLo = lo
      this.camHi = hi
      this.camReady = true
      return
    }
    const glide = 1 - Math.exp(-2.4 * dt)
    this.camLo += (lo - this.camLo) * glide
    this.camHi += (hi - this.camHi) * glide
  }

  private separateHands() {
    if (this.left.home > this.right.home - 7) {
      const mid = (this.left.home + this.right.home) / 2
      this.left.home = mid - 4
      this.right.home = mid + 4
    }
  }

  private updateHand(hand: HandState, time: number, dt: number, layout: Layout) {
    const active: number[] = []
    const sounding: number[] = []
    if (this.notes) {
      for (const note of this.notes) {
        if (note.hand !== hand.side) continue
        if (time >= note.start - 0.11 && time < note.end + 0.02) active.push(note.midi)
        if (time >= note.start && time < note.end) sounding.push(note.midi)
      }
    }
    if (active.length) {
      const avg = active.reduce((sum, midi) => sum + midi, 0) / active.length
      const follow = hand.ready ? 1 - Math.exp(-3.2 * dt) : 1
      hand.home += (avg - hand.home) * follow
    }
    const targets = fingerMidis(hand.side, active, hand.home)
    const glide = hand.ready ? 1 - Math.exp(-12 * dt) : 1
    const pressGlide = hand.ready ? 1 - Math.exp(-18 * dt) : 1
    for (let index = 0; index < 5; index++) {
      const midi = targets[index]
      const finger = hand.fingers[index]
      const pressed = sounding.some((playing) => Math.abs(playing - midi) < 0.8) ? 1 : 0
      finger.midi = midi
      finger.x += (layout.centerX(midi) - finger.x) * glide
      finger.y += (this.fingerY(midi, pressed) - finger.y) * glide
      finger.pressed += (pressed - finger.pressed) * pressGlide
    }
    const palmTarget = (hand.fingers[1].x + hand.fingers[2].x + hand.fingers[3].x) / 3
    const palmGlide = hand.ready ? 1 - Math.exp(-7 * dt) : 1
    hand.palmX += (palmTarget - hand.palmX) * palmGlide
    hand.ready = true
  }

  private fingerY(midi: number, pressed: number): number {
    const whiteH = this.h - this.keyboardTop
    const reach = isBlack(midi) ? 0.4 : 0.66
    return this.keyboardTop + whiteH * reach + pressed * Math.min(14, whiteH * 0.035)
  }

  private activeNotes(time: number): Map<number, NoteEvent> {
    const active = new Map<number, NoteEvent>()
    if (!this.notes) return active
    for (const note of this.notes) {
      if (time < note.start || time >= note.end) continue
      const prev = active.get(note.midi)
      if (!prev || note.velocity > prev.velocity) active.set(note.midi, note)
    }
    return active
  }

  private drawNotes(time: number, layout: Layout) {
    if (!this.notes) return
    const ctx = this.ctx
    const speed = (this.keyboardTop * 0.9) / LOOKAHEAD
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, this.w, this.keyboardTop)
    ctx.clip()
    for (const note of this.notes) {
      let yBottom = this.keyboardTop - (note.start - time) * speed
      let yTop = this.keyboardTop - (note.end - time) * speed
      if (yBottom < -30 || yTop > this.keyboardTop) continue
      let height = yBottom - yTop
      if (height < 8) {
        yTop = yBottom - 8
        height = 8
      }
      const black = isBlack(note.midi)
      const width = Math.max(4, layout.whiteW * (black ? 0.4 : 0.58))
      const x = layout.centerX(note.midi) - width / 2
      if (x > this.w + 20 || x + width < -20) continue
      const radius = Math.min(width / 2, 10)
      const gradient = ctx.createLinearGradient(x, yTop, x, yTop + height)
      gradient.addColorStop(0, rgba(note.color, 0.18))
      gradient.addColorStop(Math.max(0, (height - 90) / height), rgba(note.color, 0.92))
      gradient.addColorStop(1, rgba(note.color, 1))
      ctx.fillStyle = rgba(note.color, 0.22)
      traceRoundRect(ctx, x - 3, yTop, width + 6, height, radius + 2)
      ctx.fill()
      ctx.fillStyle = gradient
      traceRoundRect(ctx, x, yTop, width, height, radius)
      ctx.fill()
      const cap = ctx.createLinearGradient(x, yTop + height - 14, x, yTop + height)
      cap.addColorStop(0, 'rgba(255,255,255,0)')
      cap.addColorStop(1, 'rgba(255,255,255,0.42)')
      ctx.fillStyle = cap
      traceRoundRect(ctx, x, yTop, width, height, radius)
      ctx.fill()
      if (yBottom > this.keyboardTop - 70) {
        const glow = ctx.createRadialGradient(x + width / 2, this.keyboardTop, 0, x + width / 2, this.keyboardTop, width * 1.4)
        glow.addColorStop(0, rgba(note.color, 0.55))
        glow.addColorStop(1, rgba(note.color, 0))
        ctx.fillStyle = glow
        ctx.fillRect(x - width, this.keyboardTop - width * 1.5, width * 3, width * 1.6)
      }
      if (this.showNames && width >= 13 && height >= 16) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        ctx.font = `700 ${Math.max(10, Math.min(16, width * 0.46))}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(noteLabel(note.midi, width >= 22), x + width / 2, Math.min(yBottom, this.keyboardTop) - 4)
      }
    }
    ctx.restore()
  }

  private drawKeyboard(layout: Layout, active: Map<number, NoteEvent>) {
    const ctx = this.ctx
    const top = this.keyboardTop
    const whiteH = this.h - top
    const blackH = whiteH * 0.62
    ctx.fillStyle = '#140705'
    ctx.fillRect(0, top - 4, this.w, whiteH + 8)

    for (let midi = 21; midi <= 108; midi++) {
      if (isBlack(midi)) continue
      const x = (whiteIndex(midi) - this.camLo) * layout.whiteW
      if (x > this.w || x + layout.whiteW < 0) continue
      const pressed = active.has(midi)
      const depress = pressed ? 7 : 0
      const y = top + depress
      const height = whiteH - depress
      const gradient = ctx.createLinearGradient(x, y, x, y + height)
      gradient.addColorStop(0, pressed ? '#fff6ee' : '#f4f4f2')
      gradient.addColorStop(0.12, '#ffffff')
      gradient.addColorStop(0.7, '#eeedeb')
      gradient.addColorStop(1, '#d5d3d0')
      ctx.fillStyle = gradient
      ctx.fillRect(x + 1, y, Math.max(1, layout.whiteW - 2), height)
      ctx.fillStyle = 'rgba(0,0,0,0.16)'
      ctx.fillRect(x + layout.whiteW - 3, y, 2, height)
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillRect(x + 2, y, Math.max(1, layout.whiteW - 6), 3)
      const note = active.get(midi)
      if (note) this.paintKey(x + 1, y, Math.max(1, layout.whiteW - 2), height * 0.72, note)
    }

    for (let midi = 21; midi <= 108; midi++) {
      if (!isBlack(midi)) continue
      const width = layout.whiteW * 0.56
      const x = layout.centerX(midi) - width / 2
      if (x > this.w || x + width < 0) continue
      const pressed = active.has(midi)
      const depress = pressed ? 5 : 0
      const y = top + depress
      const height = blackH - depress
      traceRoundRect(ctx, x, y, width, height, Math.min(5, width / 3))
      const gradient = ctx.createLinearGradient(x, y, x + width, y)
      gradient.addColorStop(0, '#3a3a3a')
      gradient.addColorStop(0.18, '#161616')
      gradient.addColorStop(0.55, '#2c2c2c')
      gradient.addColorStop(1, '#050505')
      ctx.fillStyle = gradient
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fillRect(x + 2, y + 3, Math.max(1, width * 0.28), height * 0.42)
      const note = active.get(midi)
      if (note) this.paintKey(x, y, width, height * 0.8, note)
    }
  }

  private paintKey(
    x: number,
    y: number,
    w: number,
    h: number,
    note: NoteEvent,
  ) {
    const ctx = this.ctx
    const glow = ctx.createLinearGradient(x, y, x, y + h)
    glow.addColorStop(0, rgba(note.color, 0.9))
    glow.addColorStop(0.5, rgba(note.color, 0.28))
    glow.addColorStop(1, rgba(note.color, 0))
    ctx.fillStyle = glow
    ctx.fillRect(x, y, w, h)
  }

  private drawFire(layout: Layout, active: Map<number, NoteEvent>) {
    const ctx = this.ctx
    const y = this.keyboardTop
    const band = ctx.createLinearGradient(0, y - 16, 0, y + 14)
    band.addColorStop(0, 'rgba(255,70,0,0)')
    band.addColorStop(0.42, 'rgba(255,50,0,0.28)')
    band.addColorStop(0.55, 'rgba(255,150,40,0.95)')
    band.addColorStop(0.72, 'rgba(255,40,0,0.45)')
    band.addColorStop(1, 'rgba(255,30,0,0)')
    ctx.fillStyle = band
    ctx.fillRect(0, y - 16, this.w, 32)
    ctx.fillStyle = 'rgba(255,236,210,0.95)'
    ctx.fillRect(0, y - 1.2, this.w, 2.4)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const [midi, note] of active) {
      const x = layout.centerX(midi)
      const radius = layout.whiteW * (isBlack(midi) ? 0.7 : 1.05)
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius)
      glow.addColorStop(0, rgba(note.color, 0.9))
      glow.addColorStop(0.4, 'rgba(255,120,30,0.45)')
      glow.addColorStop(1, 'rgba(255,40,0,0)')
      ctx.fillStyle = glow
      ctx.fillRect(x - radius, y - radius * 0.8, radius * 2, radius * 1.5)
    }
    ctx.restore()
  }

  private syncSparks(time: number, dt: number, layout: Layout) {
    if (!this.notes) return
    for (const note of this.notes) {
      if (time < note.start || note.hit) continue
      const crossed = this.prev <= note.start && time - note.start < 0.12
      note.hit = true
      if (crossed) {
        this.burst(layout.centerX(note.midi), layout.whiteW * (isBlack(note.midi) ? 0.45 : 0.7), note.color)
      }
    }
    if (dt > 0 && Math.random() < Math.min(0.8, dt * 12)) {
      for (const note of this.notes) {
        if (time < note.start || time > note.end) continue
        if (Math.random() > 0.25) continue
        this.sparks.push({
          x: layout.centerX(note.midi) + (Math.random() - 0.5) * layout.whiteW * 0.4,
          y: this.keyboardTop,
          vx: (Math.random() - 0.5) * 16,
          vy: -30 - Math.random() * 50,
          life: 0.25 + Math.random() * 0.25,
          max: 0.5,
          size: 1 + Math.random() * 1.6,
          color: Math.random() > 0.4 ? [255, 170, 70] : note.color,
        })
        break
      }
    }
  }

  private burst(x: number, spread: number, color: [number, number, number]) {
    const count = 18
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5
      const speed = 40 + Math.random() * 170
      this.sparks.push({
        x: x + (Math.random() - 0.5) * spread,
        y: this.keyboardTop + (Math.random() - 0.2) * 4,
        vx: Math.cos(angle) * speed * 0.45,
        vy: -Math.abs(Math.sin(angle)) * speed,
        life: 0.28 + Math.random() * 0.45,
        max: 0.73,
        size: 1.2 + Math.random() * 2.4,
        color: Math.random() > 0.35 ? [255, 186, 80] : color,
      })
    }
    if (this.sparks.length > 500) this.sparks.splice(0, this.sparks.length - 500)
  }

  private drawSparks(dt: number) {
    const ctx = this.ctx
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i]
      spark.life -= dt
      if (spark.life <= 0) {
        this.sparks.splice(i, 1)
        continue
      }
      spark.x += spark.vx * dt
      spark.y += spark.vy * dt
      spark.vy += 90 * dt
      spark.vx *= 0.98
      const alpha = Math.max(0, spark.life / spark.max)
      ctx.fillStyle = rgba(spark.color, alpha)
      ctx.fillRect(spark.x, spark.y, spark.size, spark.size)
    }
    ctx.restore()
  }

  private drawHand(hand: HandState, whiteW: number) {
    if (!Number.isFinite(hand.palmX)) return
    const ctx = this.ctx
    const unit = Math.max(14, Math.min(whiteW * 0.46, 32))
    const radii = [unit * 0.58, unit * 0.4, unit * 0.44, unit * 0.38, unit * 0.32]
    const side = hand.side === 'right' ? 1 : -1
    const tips = hand.fingers.map((finger) => ({ x: finger.x, y: finger.y }))
    const tipY = tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length
    const palmY = Math.min(this.h - unit * 0.8, tipY + unit * 1.55)
    const bases = tips.map((tip, index) => ({
      x: tip.x + (index === 0 ? -side * unit * 0.35 : 0),
      y: palmY,
    }))
    const span = bases.slice(1)
    const palmX = span.reduce((sum, point) => sum + point.x, 0) / span.length
    const palmW = Math.max(unit * 2.6, Math.max(...span.map((point) => point.x)) - Math.min(...span.map((point) => point.x)) + unit * 1.4)

    ctx.save()
    ctx.beginPath()
    ctx.rect(-40, this.keyboardTop - 8, this.w + 80, this.h + 40)
    ctx.clip()

    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.beginPath()
    ctx.ellipse(palmX, palmY + unit * 0.35, palmW * 0.48, unit * 0.55, 0, 0, Math.PI * 2)
    ctx.fill()

    for (const index of [4, 3, 2, 1, 0]) {
      this.drawFinger(bases[index].x, bases[index].y, tips[index].x, tips[index].y, radii[index])
    }

    ctx.fillStyle = '#e8b293'
    ctx.beginPath()
    ctx.ellipse(palmX, palmY, palmW * 0.48, unit * 1.15, side * 0.06, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(palmX - palmW * 0.22, palmY, palmW * 0.44, this.h - palmY + 8)
    ctx.fillStyle = '#f3cbb4'
    ctx.beginPath()
    ctx.ellipse(palmX - side * unit * 0.1, palmY - unit * 0.2, unit * 0.72, unit * 0.42, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private drawFinger(x0: number, y0: number, x1: number, y1: number, radius: number) {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.beginPath()
    ctx.ellipse(x1, y1 + radius * 0.28, radius * 0.95, radius * 0.4, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e4ad8c'
    fillFinger(ctx, x0, y0, radius * 1.05, x1, y1, radius * 0.92)
    ctx.fillStyle = '#f7d4bc'
    fillFinger(ctx, x0, y0, radius * 0.42, x1, y1, radius * 0.36)
    ctx.fillStyle = 'rgba(255,236,228,0.85)'
    ctx.beginPath()
    ctx.ellipse(x1, y1 - radius * 0.05, radius * 0.46, radius * 0.28, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawTitle(time: number) {
    if (!this.title || time > 4.2) return
    const alpha = time < 3.2 ? 0.8 : Math.max(0, 0.8 * (1 - (time - 3.2)))
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#fff'
    ctx.font = '600 28px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(this.title, this.w / 2, 28)
    ctx.restore()
  }
}
