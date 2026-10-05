import type { NoteEvent } from './types'
import { clampMidi, colorFor, isBlack, midiAtWhiteIndex, noteLabel, rgba, whiteIndex } from './theory'

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
  /** 0 = white-key height, 1 = raised for black keys. */
  lift: number
  ready: boolean
  fingers: Finger[]
}

interface Layout {
  whiteW: number
  centerX: (midi: number) => number
}

const LOOKAHEAD = 3.15
/** Inclusive white-key span a hand may open (thumb to pinky). */
const HAND_SPAN_NOTES = 9
/** White-key distance between outer fingers when fully open. */
const HAND_OPEN = HAND_SPAN_NOTES - 1
/** Fixed keyboard: A0 (La) through C8 (Do), scaled to fill the full width. */
const FIXED_CAM_LO = whiteIndex(21)
const FIXED_CAM_HI = whiteIndex(108) + 1

/** White-key offsets for a relaxed open hand (9 notes inclusive). */
const OPEN_FINGER_OFFSETS = [-4, -2, 0, 2, 4] as const

function makeHand(side: 'left' | 'right'): HandState {
  return {
    side,
    home: side === 'left' ? 50 : 72,
    palmX: 0,
    lift: 0,
    ready: false,
    fingers: Array.from({ length: 5 }, () => ({ x: 0, y: 0, pressed: 0, midi: 60 })),
  }
}

function whiteSpan(midis: number[]): number {
  if (midis.length <= 1) return 0
  const whites = midis.map((midi) => whiteIndex(midi))
  return Math.max(...whites) - Math.min(...whites)
}

/** Keep the densest set of notes that fits inside a 9-note white-key window. */
function fitToHandSpan(midis: number[]): number[] {
  const unique = [...new Set(midis)].sort((a, b) => a - b)
  if (unique.length <= 1) return unique
  const whites = unique.map((midi) => whiteIndex(midi))
  if (whites[whites.length - 1] - whites[0] <= HAND_OPEN) return unique

  const center = whites.reduce((sum, value) => sum + value, 0) / whites.length
  let best = unique.slice(0, 1)
  let bestScore = -Infinity
  for (let i = 0; i < unique.length; i++) {
    for (let j = i; j < unique.length; j++) {
      if (whites[j] - whites[i] > HAND_OPEN) break
      const mid = (whites[i] + whites[j]) / 2
      const score = (j - i + 1) * 1000 - Math.abs(mid - center)
      if (score > bestScore) {
        bestScore = score
        best = unique.slice(i, j + 1)
      }
    }
  }
  return best
}

function openHandMidis(side: 'left' | 'right', centerMidi: number): number[] {
  const center = whiteIndex(centerMidi)
  const offsets = side === 'right' ? OPEN_FINGER_OFFSETS : [...OPEN_FINGER_OFFSETS].reverse()
  return offsets.map((offset) => midiAtWhiteIndex(center + offset))
}

/** Force fingertip midis into a 9-note window. Locked keys stay put when they already fit. */
function enforceHandOpen(midis: number[], locked: Set<number> = new Set()): number[] {
  const result = midis.map((midi) => clampMidi(midi))
  if (whiteSpan(result) <= HAND_OPEN) return result

  if (locked.size > 0) {
    const lockedMidis = [...locked].map((finger) => result[finger])
    if (whiteSpan(lockedMidis) <= HAND_OPEN) {
      const loW = Math.min(...lockedMidis.map(whiteIndex))
      const hiW = Math.max(...lockedMidis.map(whiteIndex))
      const room = HAND_OPEN - (hiW - loW)
      const pad = Math.floor(room / 2)
      const winLo = loW - pad
      const winHi = hiW + (room - pad)
      for (let finger = 0; finger < 5; finger++) {
        if (locked.has(finger)) continue
        const w = whiteIndex(result[finger])
        if (w < winLo) result[finger] = midiAtWhiteIndex(winLo)
        else if (w > winHi) result[finger] = midiAtWhiteIndex(winHi)
      }
      return result
    }
  }

  const whites = result.map((midi) => whiteIndex(midi))
  const minW = Math.min(...whites)
  const maxW = Math.max(...whites)
  const center = (minW + maxW) / 2
  const scale = HAND_OPEN / Math.max(1, maxW - minW)
  return whites.map((value, finger) => {
    if (locked.has(finger)) return result[finger]
    return midiAtWhiteIndex(center + (value - center) * scale)
  })
}

/**
 * Order fingertips with at least 1 white key between neighbors, then clamp to 9 notes.
 * Never allows the hand to open wider than HAND_OPEN — fingers do not stretch.
 */
function spaceFingers(side: 'left' | 'right', midis: number[], locked: Set<number>): number[] {
  const whites = midis.map((midi) => whiteIndex(midi))
  const minGap = 1

  if (side === 'right') {
    for (let i = 1; i < 5; i++) {
      if (whites[i] < whites[i - 1] + minGap && !locked.has(i)) whites[i] = whites[i - 1] + minGap
    }
    for (let i = 3; i >= 0; i--) {
      if (whites[i] > whites[i + 1] - minGap && !locked.has(i)) whites[i] = whites[i + 1] - minGap
    }
  } else {
    for (let i = 1; i < 5; i++) {
      if (whites[i] > whites[i - 1] - minGap && !locked.has(i)) whites[i] = whites[i - 1] - minGap
    }
    for (let i = 3; i >= 0; i--) {
      if (whites[i] < whites[i + 1] + minGap && !locked.has(i)) whites[i] = whites[i + 1] + minGap
    }
  }

  return enforceHandOpen(
    whites.map((w) => midiAtWhiteIndex(w)),
    locked,
  )
}

/**
 * Place idle fingers inside the 9-note window around the pressed notes.
 * They never extend the hand past HAND_OPEN.
 */
function fillIdleFingers(result: number[], locked: Set<number>, side: 'left' | 'right', previous: number[]): void {
  const lockedFingers = [...locked].sort((a, b) => a - b)
  if (lockedFingers.length === 0) return

  const lockedMidis = lockedFingers.map((finger) => result[finger])
  const loW = Math.min(...lockedMidis.map(whiteIndex))
  const hiW = Math.max(...lockedMidis.map(whiteIndex))
  const room = Math.max(0, HAND_OPEN - (hiW - loW))
  const pad = Math.floor(room / 2)
  const spanLoW = loW - pad
  const spanHiW = hiW + (room - pad)

  for (let finger = 0; finger < 5; finger++) {
    if (locked.has(finger)) continue
    let left = -1
    let right = -1
    for (let i = finger - 1; i >= 0; i--) {
      if (locked.has(i)) {
        left = i
        break
      }
    }
    for (let i = finger + 1; i < 5; i++) {
      if (locked.has(i)) {
        right = i
        break
      }
    }
    const prevW = whiteIndex(previous[finger])
    if (prevW >= spanLoW && prevW <= spanHiW) {
      const leftMidi = left >= 0 ? result[left] : null
      const rightMidi = right >= 0 ? result[right] : null
      const between =
        (leftMidi == null ||
          (side === 'right' ? previous[finger] >= leftMidi - 0.01 : previous[finger] <= leftMidi + 0.01)) &&
        (rightMidi == null ||
          (side === 'right' ? previous[finger] <= rightMidi + 0.01 : previous[finger] >= rightMidi - 0.01))
      if (between) {
        result[finger] = previous[finger]
        continue
      }
    }
    if (left >= 0 && right >= 0) {
      const t = (finger - left) / (right - left)
      result[finger] = result[left] + (result[right] - result[left]) * t
    } else if (left >= 0) {
      const edge = side === 'right' ? midiAtWhiteIndex(spanHiW) : midiAtWhiteIndex(spanLoW)
      const steps = finger - left
      result[finger] = result[left] + ((edge - result[left]) * steps) / Math.max(1, 4 - left)
    } else if (right >= 0) {
      const edge = side === 'right' ? midiAtWhiteIndex(spanLoW) : midiAtWhiteIndex(spanHiW)
      const steps = right - finger
      result[finger] = result[right] + ((edge - result[right]) * steps) / Math.max(1, right)
    } else {
      result[finger] = midiAtWhiteIndex(Math.min(spanHiW, Math.max(spanLoW, prevW)))
    }
    result[finger] = clampMidi(result[finger])
  }
}

/** True when every note sits inside a 9-note window around the hand's current pose. */
function withinHandReach(prev: number[], notes: number[]): boolean {
  if (notes.length === 0) return true
  const prevWhites = prev.map((midi) => whiteIndex(midi))
  const center = (Math.min(...prevWhites) + Math.max(...prevWhites)) / 2
  const reachLo = center - HAND_OPEN / 2
  const reachHi = center + HAND_OPEN / 2
  const needLo = whiteIndex(Math.min(...notes))
  const needHi = whiteIndex(Math.max(...notes))
  return needLo >= reachLo - 0.01 && needHi <= reachHi + 0.01 && needHi - needLo <= HAND_OPEN
}

/**
 * Assign active notes inside a hard 9-note hand.
 * If notes are too far from the current pose, the whole hand jumps — fingers never stretch.
 */
function fingerMidis(
  side: 'left' | 'right',
  active: number[],
  home: number,
  previous: number[] | null,
): number[] {
  const unique = [...new Set(active)].sort((a, b) => a - b)
  const covering =
    unique.length <= 5 && whiteSpan(unique) <= HAND_OPEN ? unique : fitToHandSpan(unique)
  const prev = previous?.map((midi) => clampMidi(midi)) ?? openHandMidis(side, home)

  if (covering.length === 0) return spaceFingers(side, prev, new Set())

  const needLo = whiteIndex(Math.min(...covering))
  const needHi = whiteIndex(Math.max(...covering))
  const winCenter = (needLo + needHi) / 2

  // Jump the whole hand whenever notes sit outside the current 9-note reach.
  // Never stretch a finger to chase a distant key.
  const jump = !withinHandReach(prev, covering)
  const base = jump ? openHandMidis(side, midiAtWhiteIndex(winCenter)) : prev
  const notes = side === 'right' ? covering.slice() : covering.slice().reverse()
  const count = notes.length

  let bestStart = 0
  let bestCost = Infinity
  for (let start = 0; start <= 5 - count; start++) {
    let cost = 0
    for (let i = 0; i < count; i++) {
      const finger = start + i
      const dist = Math.abs(whiteIndex(base[finger]) - whiteIndex(notes[i]))
      const sticky = !jump && Math.abs(base[finger] - notes[i]) <= 0.85 ? -4 : 0
      cost += dist + sticky
    }
    cost += start * 0.1
    if (cost < bestCost) {
      bestCost = cost
      bestStart = start
    }
  }

  const locked = new Set<number>()
  const result = base.slice()
  for (let i = 0; i < count; i++) {
    const finger = bestStart + i
    result[finger] = notes[i]
    locked.add(finger)
  }

  fillIdleFingers(result, locked, side, base)
  return spaceFingers(side, result, locked)
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

const SKIN_DARK: [number, number, number] = [168, 108, 78]
const SKIN_MID: [number, number, number] = [214, 158, 122]
const SKIN_LIGHT: [number, number, number] = [236, 196, 164]
const SKIN_NAIL: [number, number, number] = [244, 220, 204]
const GLOW: [number, number, number] = [255, 122, 50]

function fillCapsule(
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

/** Tip depth on the key (0 thumb … 4 pinky). Negative = deeper into the keyboard. */
const FINGER_TIP_DEPTH = [0.1, 0.02, -0.05, 0.01, 0.08] as const
/** Dome / arch strength — middle highest, thumb flatter, pinky lower. */
const FINGER_ARCH = [0.3, 1.0, 1.18, 0.92, 0.5] as const
/** Knuckle row offset in palm units (negative = knuckles closer to tips = taller arch). */
const FINGER_KNUCKLE_LIFT = [0.28, -0.1, -0.24, -0.08, 0.1] as const

function fingerChain(
  baseX: number,
  baseY: number,
  tipX: number,
  tipY: number,
  side: number,
  fingerIndex: number,
  pressed: number,
  thickness: number,
): Array<{ x: number; y: number; r: number }> {
  const isThumb = fingerIndex === 0
  const isOuter = fingerIndex === 0 || fingerIndex === 4
  const arch = FINGER_ARCH[fingerIndex]
  const dx = tipX - baseX
  const dy = tipY - baseY
  const len = Math.hypot(dx, dy) || 1
  // Hammer curl bends toward the palm (down the screen), never up toward the notes.
  const bend = Math.min(isThumb ? 10 : 30, len * (0.045 + 0.09 * arch)) * arch * (1 - pressed * 0.45)
  const peak = thickness * (0.55 + arch * 1.6)
  // No outward splay on thumb/pinky — joints stay on the base→tip line.
  const lateral = isOuter ? 0 : side * thickness * (0.03 + arch * 0.02)
  const knukleX = baseX + dx * 0.3 + lateral * 0.08
  const knukleY = baseY + dy * 0.28 + bend * 0.35 + peak * 0.18
  const midX = baseX + dx * 0.62 + lateral * 0.2
  const midY = baseY + dy * 0.6 + bend + peak * 0.5
  const tipRadius = isThumb ? 0.7 : 0.55
  const midRadius = isThumb ? 0.88 : 0.72 + arch * 0.05
  const baseRadius = isThumb ? 1.02 : 0.88 + arch * 0.06
  const unit = thickness * (0.9 + arch * 0.06)
  return [
    { x: baseX, y: baseY, r: unit * baseRadius },
    { x: knukleX, y: knukleY, r: unit * midRadius },
    { x: midX, y: midY, r: unit * tipRadius * 1.06 },
    { x: tipX, y: tipY, r: unit * tipRadius },
  ]
}

export class Visualizer {
  private notes: NoteEvent[] | null = null
  private title = ''
  private showNames = false
  private showHands = true
  private zoom = false
  private w = 1280
  private h = 720
  private keyboardTop = 500
  private camLo = FIXED_CAM_LO
  private camHi = FIXED_CAM_HI
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

  setShowHands(show: boolean) {
    this.showHands = show
  }

  setZoom(enabled: boolean) {
    this.zoom = enabled
    this.camReady = false
    if (!enabled) {
      this.camLo = FIXED_CAM_LO
      this.camHi = FIXED_CAM_HI
    }
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
    this.left.lift = 0
    this.right.lift = 0
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
    this.reassignDistantNotes(time)
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
    if (this.showHands) {
      this.drawHand(this.left, layout.whiteW)
      this.drawHand(this.right, layout.whiteW)
    }
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
    if (!this.zoom) {
      this.camLo = FIXED_CAM_LO
      this.camHi = FIXED_CAM_HI
      this.camReady = true
      return
    }
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
    // Only stop the hands from crossing — do not shove them apart by a fixed gap.
    if (this.left.home < this.right.home - 1) return
    const mid = (this.left.home + this.right.home) / 2
    this.left.home = mid - 1.5
    this.right.home = mid + 1.5
  }

  /**
   * If a note is outside a hand's 9-note reach, give it to the other hand when that
   * hand has free fingers and can cover it without stretching past HAND_OPEN.
   */
  private reassignDistantNotes(time: number) {
    if (!this.notes) return

    const activeFor = (side: 'left' | 'right') =>
      this.notes!.filter(
        (note) =>
          note.hand === side && time >= note.start - 0.11 && time < note.end + 0.02,
      )

    const poseOf = (hand: HandState) =>
      hand.ready ? hand.fingers.map((finger) => finger.midi) : openHandMidis(hand.side, hand.home)

    const tryMove = (from: HandState, to: HandState) => {
      const fromNotes = activeFor(from.side)
      const toNotes = activeFor(to.side)
      if (fromNotes.length === 0 || toNotes.length >= 5) return

      const fromPose = poseOf(from)
      const toPose = poseOf(to)
      const toMidis = toNotes.map((note) => note.midi)
      const fromMidis = fromNotes.map((note) => note.midi)
      const fromOverloaded =
        fromNotes.length > 5 || whiteSpan(fromMidis) > HAND_OPEN

      // Prefer moving notes that are farthest from the current hand center.
      const fromCenter =
        (Math.min(...fromPose.map(whiteIndex)) + Math.max(...fromPose.map(whiteIndex))) / 2
      const ordered = [...fromNotes].sort(
        (a, b) =>
          Math.abs(whiteIndex(b.midi) - fromCenter) - Math.abs(whiteIndex(a.midi) - fromCenter),
      )

      for (const note of ordered) {
        if (toNotes.length >= 5) break
        const outOfReach = !withinHandReach(fromPose, [note.midi])
        if (!outOfReach && !fromOverloaded) continue
        const candidate = [...toMidis, note.midi]
        if (candidate.length > 5 || whiteSpan(candidate) > HAND_OPEN) continue

        const toCanReach = withinHandReach(toPose, candidate)
        if (!toCanReach && !outOfReach) {
          const fromDist = Math.abs(whiteIndex(note.midi) - whiteIndex(from.home))
          const toDist = Math.abs(whiteIndex(note.midi) - whiteIndex(to.home))
          if (toDist >= fromDist - 0.5) continue
        }

        note.hand = to.side
        note.color = colorFor(to.side, note.midi)
        toMidis.push(note.midi)
        toNotes.push(note)
      }
    }

    tryMove(this.left, this.right)
    tryMove(this.right, this.left)
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
    // Home follows the notes this hand must play (prefer sounding), not a forced wide stance.
    const focus = sounding.length ? sounding : active
    if (focus.length) {
      const lo = Math.min(...focus)
      const hi = Math.max(...focus)
      const targetHome = (lo + hi) / 2
      const follow = hand.ready ? 1 - Math.exp(-5.5 * dt) : 1
      hand.home += (targetHome - hand.home) * follow
    }
    const previous = hand.ready ? hand.fingers.map((finger) => finger.midi) : null
    const targets = fingerMidis(hand.side, active, hand.home, previous)
    // Whole-hand jump: snap tips so the hand relocates instead of stretching mid-glide.
    const coverCheck =
      active.length <= 5 && whiteSpan(active) <= HAND_OPEN ? active : fitToHandSpan(active)
    const jumped = Boolean(previous && coverCheck.length && !withinHandReach(previous, coverCheck))
    const glide = jumped || !hand.ready ? 1 : 1 - Math.exp(-9 * dt)
    const pressGlide = hand.ready ? 1 - Math.exp(-16 * dt) : 1
    const liftGlide = hand.ready ? 1 - Math.exp(-8 * dt) : 1
    const thumbShift = layout.whiteW * (hand.side === 'right' ? -0.18 : 0.18)
    // Raise the whole hand for sharps instead of stretching individual fingers.
    const liftTarget = targets.some((midi) => isBlack(midi)) ? 1 : 0
    hand.lift += (liftTarget - hand.lift) * (jumped ? 1 : liftGlide)
    const liftPx = hand.lift * this.blackKeyLift()
    for (let index = 0; index < 5; index++) {
      const midi = targets[index]
      const finger = hand.fingers[index]
      const pressed = sounding.some((playing) => Math.abs(playing - midi) < 0.8) ? 1 : 0
      finger.midi = midi
      const tipX = layout.centerX(midi) + (index === 0 ? thumbShift : 0)
      finger.x += (tipX - finger.x) * glide
      finger.y += (this.fingerY(index, pressed) - liftPx - finger.y) * glide
      finger.pressed += (pressed - finger.pressed) * pressGlide
    }
    if (jumped) {
      hand.palmX =
        hand.fingers[1].x * 0.25 +
        hand.fingers[2].x * 0.45 +
        hand.fingers[3].x * 0.3 +
        (hand.side === 'right' ? 6 : -6)
    }
    // Keep tips ordered without opening the hand past 9 white keys.
    this.uncrossFingerPositions(hand, Math.max(6, layout.whiteW * 0.55), layout.whiteW)
    const palmTarget =
      hand.fingers[1].x * 0.25 + hand.fingers[2].x * 0.45 + hand.fingers[3].x * 0.3 + (hand.side === 'right' ? 6 : -6)
    const palmGlide = hand.ready ? 1 - Math.exp(-5.5 * dt) : 1
    hand.palmX += (palmTarget - hand.palmX) * palmGlide
    hand.ready = true
  }

  /** Keep live tip X ordered; never open wider than 9 white keys. */
  private uncrossFingerPositions(hand: HandState, minGap: number, whiteW: number) {
    const tips = hand.fingers
    if (hand.side === 'right') {
      for (let i = 1; i < 5; i++) {
        if (tips[i].x < tips[i - 1].x + minGap) tips[i].x = tips[i - 1].x + minGap
      }
      for (let i = 3; i >= 0; i--) {
        if (tips[i].x > tips[i + 1].x - minGap) tips[i].x = tips[i + 1].x - minGap
      }
    } else {
      for (let i = 1; i < 5; i++) {
        if (tips[i].x > tips[i - 1].x - minGap) tips[i].x = tips[i - 1].x - minGap
      }
      for (let i = 3; i >= 0; i--) {
        if (tips[i].x < tips[i + 1].x + minGap) tips[i].x = tips[i + 1].x + minGap
      }
    }

    // Hard visual clamp: tip span must stay inside HAND_OPEN white keys.
    const xs = tips.map((finger) => finger.x)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const maxSpan = whiteW * HAND_OPEN
    if (maxX - minX <= maxSpan + 0.01) return
    const center = (minX + maxX) / 2
    const scale = maxSpan / Math.max(1, maxX - minX)
    for (const finger of tips) {
      finger.x = center + (finger.x - center) * scale
    }
  }

  /** How far the hand rises to play black keys without lengthening fingers. */
  private blackKeyLift(): number {
    return (this.h - this.keyboardTop) * 0.22
  }

  private fingerY(index: number, pressed: number): number {
    const whiteH = this.h - this.keyboardTop
    const depth = FINGER_TIP_DEPTH[index] ?? 0
    return this.keyboardTop + whiteH * (0.58 + depth) + pressed * Math.min(18, whiteH * 0.05)
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
      const index = whiteIndex(midi)
      const x = (index - this.camLo) * layout.whiteW
      const nextX = (index + 1 - this.camLo) * layout.whiteW
      if (nextX < 0 || x > this.w) continue
      const left = Math.max(0, x)
      const right = Math.min(this.w, nextX)
      const keyW = right - left
      if (keyW <= 0) continue
      const pressed = active.has(midi)
      const depress = pressed ? 7 : 0
      const y = top + depress
      const height = whiteH - depress
      const gradient = ctx.createLinearGradient(left, y, left, y + height)
      gradient.addColorStop(0, pressed ? '#fff6ee' : '#f4f4f2')
      gradient.addColorStop(0.12, '#ffffff')
      gradient.addColorStop(0.7, '#eeedeb')
      gradient.addColorStop(1, '#d5d3d0')
      ctx.fillStyle = gradient
      ctx.fillRect(left, y, keyW, height)
      if (right < this.w - 0.5) {
        ctx.fillStyle = 'rgba(0,0,0,0.16)'
        ctx.fillRect(right - 2, y, 2, height)
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillRect(left, y, keyW, 3)
      const note = active.get(midi)
      if (note) this.paintKey(left, y, keyW, height * 0.72, note)
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
    // Open 9 notes with slender, long fingers — palm narrower than the tips.
    const openPx = whiteW * HAND_OPEN
    const unit = Math.max(10, Math.min(openPx / 11.5, whiteW * 0.92))
    const side = hand.side === 'right' ? 1 : -1
    const tips = hand.fingers.map((finger) => ({
      x: finger.x,
      y: finger.y,
      pressed: finger.pressed,
    }))
    const tipMin = Math.min(...tips.map((tip) => tip.x))
    const tipMax = Math.max(...tips.map((tip) => tip.x))
    const tipSpan = Math.min(openPx, Math.max(openPx * 0.55, tipMax - tipMin))
    const tipCenter = (tipMin + tipMax) / 2
    const tipY = tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length
    // Longer hand so outer fingers reach without bending sideways.
    const fingerLen = Math.max(unit * 7.1, openPx * 0.92)
    const palmY = Math.min(this.h - unit * 0.35, tipY + fingerLen)
    const palmX = tipCenter * 0.55 + hand.palmX * 0.45 + side * unit * 0.04

    // Knuckles closer to tip span; thumb/pinky stay under the hand, not flared out.
    const knuckleScale = 0.8
    const bases = tips.map((tip, index) => {
      let x = palmX + (tip.x - tipCenter) * knuckleScale
      let y = palmY + FINGER_KNUCKLE_LIFT[index] * unit * 1.4
      if (index === 0) {
        // Thumb root under the palm edge, aligned toward its tip — no outward flare.
        x = tip.x * 0.4 + palmX * 0.6 - side * unit * 0.45
        y = palmY + unit * 0.55
      } else if (index === 1) {
        x = palmX + (tip.x - tipCenter) * (knuckleScale * 0.92)
      } else if (index === 4) {
        x = palmX + (tip.x - tipCenter) * knuckleScale
        y = palmY + unit * 0.18
      }
      return { x, y }
    })
    const knuckleSpan = Math.max(...bases.map((point) => point.x)) - Math.min(...bases.map((point) => point.x))
    const palmW = Math.max(tipSpan * 0.5, knuckleSpan * 0.72 + unit * 1.2)
    const chains = tips.map((tip, index) =>
      fingerChain(bases[index].x, bases[index].y, tip.x, tip.y, side, index, tip.pressed, unit),
    )

    ctx.save()
    ctx.beginPath()
    ctx.rect(-40, this.keyboardTop - 8, this.w + 80, this.h + 40)
    ctx.clip()

    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    for (const chain of chains) {
      const tip = chain[chain.length - 1]
      ctx.beginPath()
      ctx.ellipse(tip.x, tip.y + tip.r * 0.55, tip.r * 1.2, tip.r * 0.45, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.beginPath()
    ctx.ellipse(palmX, palmY + unit * 0.5, palmW * 0.32, unit * 0.65, side * 0.04, 0, Math.PI * 2)
    ctx.fill()

    for (const index of [4, 3, 2, 1, 0]) {
      this.drawFingerChain(chains[index], tips[index].pressed, side, index === 0)
    }

    const wristTop = palmY + unit * 0.4
    const wristGrad = ctx.createLinearGradient(palmX, wristTop, palmX, this.h)
    wristGrad.addColorStop(0, rgba(SKIN_MID, 1))
    wristGrad.addColorStop(0.45, rgba(SKIN_DARK, 0.92))
    wristGrad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = wristGrad
    ctx.beginPath()
    ctx.moveTo(palmX - palmW * 0.2, wristTop)
    ctx.lineTo(palmX + palmW * 0.2, wristTop)
    ctx.lineTo(palmX + palmW * 0.14, this.h + 4)
    ctx.lineTo(palmX - palmW * 0.14, this.h + 4)
    ctx.closePath()
    ctx.fill()

    const palmGrad = ctx.createRadialGradient(
      palmX - side * unit * 0.15,
      palmY - unit * 0.2,
      unit * 0.2,
      palmX,
      palmY + unit * 0.15,
      palmW * 0.55,
    )
    palmGrad.addColorStop(0, rgba(SKIN_LIGHT, 1))
    palmGrad.addColorStop(0.55, rgba(SKIN_MID, 1))
    palmGrad.addColorStop(1, rgba(SKIN_DARK, 1))
    ctx.fillStyle = palmGrad
    // Tall palm oval (hand), not a wide flat pad (foot).
    ctx.beginPath()
    ctx.ellipse(palmX, palmY, palmW * 0.36, unit * 1.55, side * 0.07, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = rgba(SKIN_LIGHT, 0.5)
    ctx.beginPath()
    ctx.ellipse(palmX - side * unit * 0.16, palmY - unit * 0.4, unit * 0.55, unit * 0.32, side * 0.1, 0, Math.PI * 2)
    ctx.fill()

    const under = ctx.createRadialGradient(palmX, palmY - unit * 0.15, unit * 0.2, palmX, palmY, palmW * 0.45)
    under.addColorStop(0, rgba(GLOW, 0.18))
    under.addColorStop(1, rgba(GLOW, 0))
    ctx.fillStyle = under
    ctx.beginPath()
    ctx.ellipse(palmX, palmY - unit * 0.2, palmW * 0.3, unit * 1.05, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private drawFingerChain(
    chain: Array<{ x: number; y: number; r: number }>,
    pressed: number,
    side: number,
    isThumb: boolean,
  ) {
    const ctx = this.ctx
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i]
      const b = chain[i + 1]
      ctx.fillStyle = 'rgba(0,0,0,0.18)'
      fillCapsule(ctx, a.x + 1.2, a.y + 2.2, a.r * 1.02, b.x + 1.2, b.y + 2.2, b.r * 1.02)

      const skin = ctx.createLinearGradient(a.x - a.r, a.y, b.x + b.r, b.y)
      skin.addColorStop(0, rgba(SKIN_DARK, 1))
      skin.addColorStop(0.35, rgba(SKIN_MID, 1))
      skin.addColorStop(0.75, rgba(SKIN_LIGHT, 1))
      skin.addColorStop(1, rgba(SKIN_MID, 1))
      ctx.fillStyle = skin
      fillCapsule(ctx, a.x, a.y, a.r, b.x, b.y, b.r)

      ctx.fillStyle = rgba(SKIN_LIGHT, 0.35)
      fillCapsule(ctx, a.x - side * a.r * 0.18, a.y - a.r * 0.12, a.r * 0.42, b.x - side * b.r * 0.18, b.y - b.r * 0.12, b.r * 0.36)
    }

    const tip = chain[chain.length - 1]
    const glow = Math.max(0.12, pressed * 0.55)
    const tipGlow = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, tip.r * 2.2)
    tipGlow.addColorStop(0, rgba(GLOW, glow))
    tipGlow.addColorStop(1, rgba(GLOW, 0))
    ctx.fillStyle = tipGlow
    ctx.beginPath()
    ctx.ellipse(tip.x, tip.y + tip.r * 0.15, tip.r * 1.8, tip.r * 1.1, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = rgba(SKIN_NAIL, 0.9)
    ctx.beginPath()
    ctx.ellipse(tip.x, tip.y - tip.r * 0.08, tip.r * (isThumb ? 0.55 : 0.48), tip.r * 0.32, side * 0.12, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = rgba(GLOW, 0.18 + pressed * 0.25)
    ctx.beginPath()
    ctx.ellipse(tip.x, tip.y + tip.r * 0.2, tip.r * 0.7, tip.r * 0.28, 0, 0, Math.PI * 2)
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
