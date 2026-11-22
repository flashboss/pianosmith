import {
  detectTimeSignature,
  estimateBpm,
  measureSeconds,
  measureSixteenthTicks,
  tempoLabel,
  type TimeSignature,
} from './meter'
import { groupChords, rhythmEventsForMeasure, type RhythmDur, type RhythmEvent } from './rhythm'
import type { NoteEvent } from './types'
import { noteLabel, rgba } from './theory'

/** Live scrolling grand-staff view with line wraps filling the page. */

export type SheetTheme = 'light' | 'dark'

type SheetPalette = {
  page: string
  staff: string
  ink: string
  barSoft: string
  barStrong: string
  label: string
  activeWash: string
  noteInkScale: number
  sustainActive: number
  sustainIdle: number
  activeRing: string
}

const THEMES: Record<SheetTheme, SheetPalette> = {
  light: {
    page: '#ffffff',
    staff: 'rgba(20,20,20,0.85)',
    ink: 'rgba(15,15,15,0.95)',
    barSoft: 'rgba(30,30,30,0.22)',
    barStrong: 'rgba(20,20,20,0.75)',
    label: 'rgba(20,20,20,0.9)',
    activeWash: 'rgba(255,122,50,0.08)',
    noteInkScale: 0.42,
    sustainActive: 0.22,
    sustainIdle: 0.12,
    activeRing: 'rgba(255,255,255,0)',
  },
  dark: {
    page: '#121216',
    staff: 'rgba(230,230,230,0.55)',
    ink: 'rgba(245,245,245,0.88)',
    barSoft: 'rgba(255,255,255,0.1)',
    barStrong: 'rgba(230,230,230,0.45)',
    label: 'rgba(255,255,255,0.9)',
    activeWash: 'rgba(255,122,50,0.06)',
    noteInkScale: 1,
    sustainActive: 0.28,
    sustainIdle: 0.14,
    activeRing: 'rgba(255,255,255,0.85)',
  },
}

/** Sharp spelling: C# sits on the C line. Flat spelling: Db sits on the D line. */
const LETTER_STEPS_SHARP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6] as const
const LETTER_STEPS_FLAT = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6] as const
const SHARP_PC = [false, true, false, true, false, false, true, false, true, false, true, false]
/** Black keys spelled as flats: Db Eb Gb Ab Bb */
const FLAT_BLACK_PC = [false, true, false, true, false, false, true, false, true, false, true, false]

/** Order of sharps / flats in a key signature. */
const SHARP_ORDER = [5, 0, 7, 2, 9, 4, 11] as const // F C G D A E B
const FLAT_ORDER = [10, 3, 8, 1, 6, 11, 4] as const // B E A D G C F
/** Staff-placement MIDI for standard key-signature positions. */
const TREBLE_SHARP_MIDI = [77, 72, 79, 74, 69, 76, 71] as const
const TREBLE_FLAT_MIDI = [71, 76, 69, 74, 67, 72, 65] as const
const BASS_SHARP_MIDI = [53, 48, 55, 50, 45, 52, 47] as const
const BASS_FLAT_MIDI = [47, 52, 45, 50, 43, 48, 41] as const

/** Major tonic pitch-class → fifths (−7…7). */
const MAJOR_FIFTHS = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5] as const
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export type KeySignature = { fifths: number; mode: 'major' | 'minor'; tonicPc: number }

function preferCloserFifths(fifths: number): number {
  let f = fifths
  if (f > 6) f -= 12
  if (f < -6) f += 12
  return Math.max(-7, Math.min(7, f))
}

/** Detect key signature from note content (Krumhansl–Schmuckler + fewer accidentals bias). */
export function detectKeySignature(notes: NoteEvent[]): KeySignature {
  const hist = new Array(12).fill(0)
  let total = 0
  for (const note of notes) {
    const dur = Math.max(0.04, note.end - note.start)
    const w = dur * (0.55 + (note.velocity || 80) / 200)
    const pc = ((Math.round(note.midi) % 12) + 12) % 12
    hist[pc] += w
    total += w
  }
  if (total < 0.01) return { fifths: 0, mode: 'major', tonicPc: 0 }

  let best: KeySignature & { score: number } = {
    fifths: 0,
    mode: 'major',
    tonicPc: 0,
    score: -Infinity,
  }
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? KS_MAJOR : KS_MINOR
      let corr = 0
      for (let i = 0; i < 12; i++) {
        corr += hist[i] * profile[(i - tonic + 12) % 12]
      }
      const relMajor = mode === 'major' ? tonic : (tonic + 3) % 12
      const fifths = preferCloserFifths(MAJOR_FIFTHS[relMajor])
      const score = corr / total - Math.abs(fifths) * 0.08
      if (score > best.score) best = { fifths, mode, tonicPc: tonic, score }
    }
  }
  return { fifths: best.fifths, mode: best.mode, tonicPc: best.tonicPc }
}

function alteredPcs(fifths: number): Set<number> {
  const set = new Set<number>()
  if (fifths > 0) {
    for (let i = 0; i < fifths; i++) set.add(SHARP_ORDER[i])
  } else if (fifths < 0) {
    for (let i = 0; i < -fifths; i++) set.add(FLAT_ORDER[i])
  }
  return set
}

function diatonicFromC0(midi: number, fifths: number): number {
  const m = Math.max(12, Math.min(108, Math.round(midi)))
  const octave = Math.floor(m / 12) - 1
  const pc = ((m % 12) + 12) % 12
  const steps = fifths < 0 ? LETTER_STEPS_FLAT[pc] : LETTER_STEPS_SHARP[pc]
  return octave * 7 + steps
}

/** Accidental to draw beside a note head (null if covered by the key signature). */
function noteAccidental(midi: number, fifths: number): '#' | 'b' | null {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  const keyed = alteredPcs(fifths)
  if (fifths < 0) {
    if (!FLAT_BLACK_PC[pc]) return null
    return keyed.has(pc) ? null : 'b'
  }
  if (!SHARP_PC[pc]) return null
  return keyed.has(pc) ? null : '#'
}

function pitchY(
  midi: number,
  clef: 'treble' | 'bass',
  staffTop: number,
  gap: number,
  fifths: number,
): number {
  const refMidi = clef === 'treble' ? 64 : 43
  const steps = diatonicFromC0(midi, fifths) - diatonicFromC0(refMidi, fifths)
  return staffTop + 4 * gap - steps * (gap / 2)
}

function needsLedger(midi: number, clef: 'treble' | 'bass', fifths: number): number[] {
  const yRef = clef === 'treble' ? 64 : 43
  const topRef = clef === 'treble' ? 77 : 57
  const d = diatonicFromC0(midi, fifths)
  const dLo = diatonicFromC0(yRef, fifths)
  const dHi = diatonicFromC0(topRef, fifths)
  const lines: number[] = []
  if (d < dLo) {
    for (let s = dLo - 2; s >= d; s -= 2) lines.push(s)
  } else if (d > dHi) {
    for (let s = dHi + 2; s <= d; s += 2) lines.push(s)
  }
  return lines
}

type PageLayout = {
  gap: number
  systems: number
  systemH: number
  topPad: number
  staffLeft: number
  staffRight: number
  clefLeft: number
  contentLeft: number
  contentW: number
  measuresPerSystem: number
  measureSec: number
  systemSec: number
  pxPerSec: number
  fifths: number
  bpm: number
  timeSig: TimeSignature
  timeSigX: number
}

function pageLayout(
  w: number,
  areaH: number,
  fifths: number,
  bpm: number,
  timeSig: TimeSignature,
  systems: number,
  /** When set, keep bar packing stable across frames/resizes. */
  freezeMeasuresPerSystem?: number,
): PageLayout {
  const height = Math.max(160, areaH)
  const staffLeft = 14
  const staffRight = w - 10
  const topPad = Math.max(34, Math.min(78, height * 0.14))
  const usableH = Math.max(120, height - topPad)
  const systemH = usableH / Math.max(1, systems)
  const gap = Math.max(4.2, Math.min(10, systemH / 14.5))
  const clefLeft = staffLeft + 4
  const clefWidth = Math.max(28, gap * 3.6)
  const keySigWidth = Math.abs(fifths) * gap * 0.78 + (fifths !== 0 ? gap * 0.35 : 0)
  const timeSigX = clefLeft + clefWidth + keySigWidth
  const timeSigWidth = gap * 2.4
  const contentLeft = timeSigX + timeSigWidth
  const contentW = Math.max(80, staffRight - contentLeft)
  const measureSec = measureSeconds(bpm, timeSig)
  // Prefer ~measure-width that stays readable while packing 2–4 bars per system.
  const measuresPerSystem =
    freezeMeasuresPerSystem ??
    Math.max(2, Math.min(4, Math.round(contentW / Math.max(100, gap * 16 + measureSec * 18))))
  const systemSec = measuresPerSystem * measureSec
  const pxPerSec = contentW / systemSec
  return {
    gap,
    systems,
    systemH,
    topPad,
    staffLeft,
    staffRight,
    clefLeft,
    contentLeft,
    contentW,
    measuresPerSystem,
    measureSec,
    systemSec,
    pxPerSec,
    fifths,
    bpm,
    timeSig,
    timeSigX,
  }
}

function drawStaffLines(
  ctx: CanvasRenderingContext2D,
  top: number,
  gap: number,
  left: number,
  right: number,
  theme: SheetPalette,
) {
  ctx.strokeStyle = theme.staff
  ctx.lineWidth = 1.15
  for (let i = 0; i < 5; i++) {
    const y = top + i * gap
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
  }
}

function drawClef(
  ctx: CanvasRenderingContext2D,
  top: number,
  gap: number,
  left: number,
  clef: 'treble' | 'bass',
  theme: SheetPalette,
) {
  ctx.fillStyle = theme.ink
  const glyph = clef === 'treble' ? '𝄞' : '𝄢'
  const fallback = clef === 'treble' ? 'G' : 'F'
  ctx.font = `700 ${Math.round(gap * (clef === 'treble' ? 3.4 : 3))}px "Times New Roman", Georgia, serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const mark = ctx.measureText(glyph).width > gap * 0.35 ? glyph : fallback
  if (mark === fallback) {
    ctx.font = `700 ${Math.round(gap * 2.2)}px system-ui, sans-serif`
  }
  ctx.fillText(mark, left + 2, top + gap * 2)
}

function drawKeySignature(
  ctx: CanvasRenderingContext2D,
  staffTop: number,
  gap: number,
  startX: number,
  clef: 'treble' | 'bass',
  fifths: number,
  theme: SheetPalette,
) {
  const count = Math.abs(fifths)
  if (count === 0) return
  const sharp = fifths > 0
  const midis = sharp
    ? clef === 'treble'
      ? TREBLE_SHARP_MIDI
      : BASS_SHARP_MIDI
    : clef === 'treble'
      ? TREBLE_FLAT_MIDI
      : BASS_FLAT_MIDI
  const mark = sharp ? '#' : '♭'
  ctx.fillStyle = theme.ink
  ctx.font = `700 ${Math.round(gap * (sharp ? 1.55 : 1.7))}px "Times New Roman", Georgia, serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < count; i++) {
    const x = startX + i * gap * 0.78
    const y = pitchY(midis[i], clef, staffTop, gap, fifths)
    ctx.fillText(mark, x, y + (sharp ? 0 : gap * 0.05))
  }
}

/** Stacked meter numbers (e.g. 3/4, 6/8). */
function drawTimeSignature(
  ctx: CanvasRenderingContext2D,
  staffTop: number,
  gap: number,
  x: number,
  timeSig: TimeSignature,
  theme: SheetPalette,
) {
  ctx.fillStyle = theme.ink
  ctx.font = `700 ${Math.round(gap * 2.05)}px "Times New Roman", Georgia, serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(timeSig.numerator), x, staffTop + gap * 1)
  ctx.fillText(String(timeSig.denominator), x, staffTop + gap * 3)
}

function drawTempoMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  bpm: number,
  theme: SheetPalette,
  gap: number,
) {
  const label = `${tempoLabel(bpm)}  ♩ = ${bpm}`
  ctx.fillStyle = theme.ink
  ctx.font = `italic 600 ${Math.max(11, Math.round(gap * 1.35))}px "Times New Roman", Georgia, serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.fillText(label, x, y)
}

function drawBrace(
  ctx: CanvasRenderingContext2D,
  x: number,
  trebleTop: number,
  bassBottom: number,
  theme: SheetPalette,
) {
  const mid = (trebleTop + bassBottom) / 2
  ctx.strokeStyle = theme.ink
  ctx.lineWidth = 2.2
  ctx.beginPath()
  ctx.moveTo(x + 9, trebleTop)
  ctx.bezierCurveTo(x - 2, trebleTop + 7, x - 2, mid - 8, x + 5, mid)
  ctx.bezierCurveTo(x - 2, mid + 8, x - 2, bassBottom - 7, x + 9, bassBottom)
  ctx.stroke()
}

function drawLedger(
  ctx: CanvasRenderingContext2D,
  x: number,
  midi: number,
  clef: 'treble' | 'bass',
  staffTop: number,
  gap: number,
  fifths: number,
  theme: SheetPalette,
) {
  const ref = clef === 'treble' ? 64 : 43
  ctx.strokeStyle = theme.staff
  ctx.lineWidth = 1.1
  for (const step of needsLedger(midi, clef, fifths)) {
    const y = staffTop + 4 * gap - (step - diatonicFromC0(ref, fifths)) * (gap / 2)
    ctx.beginPath()
    ctx.moveTo(x - gap * 0.9, y)
    ctx.lineTo(x + gap * 0.9, y)
    ctx.stroke()
  }
}

function inkColor(color: [number, number, number], theme: SheetPalette): [number, number, number] {
  const scale = theme.noteInkScale
  return [Math.round(color[0] * scale), Math.round(color[1] * scale), Math.round(color[2] * scale)]
}

/** Draw rests with canvas paths — music Unicode glyphs often render as tofu boxes. */
function drawRest(
  ctx: CanvasRenderingContext2D,
  x: number,
  staffTop: number,
  gap: number,
  dur: RhythmDur,
  dots: number,
  active: boolean,
  theme: SheetPalette,
) {
  const ink = theme.noteInkScale < 1 ? ([30, 30, 30] as [number, number, number]) : ([235, 235, 235] as [number, number, number])
  const alpha = active ? 1 : 0.9
  ctx.fillStyle = rgba(ink, alpha)
  ctx.strokeStyle = rgba(ink, alpha)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const mid = staffTop + gap * 2
  let dotY = mid

  if (dur === 'w' || dur === 'h') {
    // Whole hangs under the 2nd line; half sits on the 3rd line.
    const lineY = dur === 'w' ? staffTop + gap : staffTop + gap * 2
    const barH = Math.max(3, gap * 0.42)
    const barW = gap * 1.15
    const y = dur === 'w' ? lineY + 1 : lineY - barH - 1
    ctx.fillRect(x - barW / 2, y, barW, barH)
    dotY = y + barH / 2
  } else if (dur === 'q') {
    // Classic quarter-rest zigzag.
    const s = gap * 0.95
    ctx.lineWidth = Math.max(1.6, gap * 0.18)
    ctx.beginPath()
    ctx.moveTo(x + s * 0.15, mid - s * 1.15)
    ctx.quadraticCurveTo(x + s * 0.85, mid - s * 0.55, x - s * 0.05, mid - s * 0.15)
    ctx.quadraticCurveTo(x + s * 0.75, mid + s * 0.25, x - s * 0.1, mid + s * 0.55)
    ctx.quadraticCurveTo(x + s * 0.55, mid + s * 0.95, x + s * 0.05, mid + s * 1.2)
    ctx.stroke()
    // Lower “hook” blob.
    ctx.beginPath()
    ctx.ellipse(x - s * 0.05, mid + s * 1.15, s * 0.22, s * 0.28, 0.4, 0, Math.PI * 2)
    ctx.fill()
    dotY = mid
  } else {
    // Eighth / sixteenth: filled head(s) on top + curved stem (not a letter “p”).
    const flags = dur === '16' ? 2 : 1
    const headR = gap * 0.26
    ctx.lineWidth = Math.max(1.6, gap * 0.17)
    // Shared stem from first head down-right.
    const stemTop = mid - gap * (flags === 1 ? 0.55 : 0.85)
    const stemBot = mid + gap * (flags === 1 ? 1.15 : 1.35)
    ctx.beginPath()
    ctx.moveTo(x + headR * 0.35, stemTop + headR * 0.15)
    ctx.bezierCurveTo(
      x + gap * 0.75,
      stemTop + gap * 0.45,
      x + gap * 0.55,
      stemBot - gap * 0.35,
      x + gap * 0.12,
      stemBot,
    )
    ctx.stroke()
    for (let i = 0; i < flags; i++) {
      const hy = stemTop + i * gap * 0.62
      const hx = x - gap * 0.02
      ctx.beginPath()
      ctx.ellipse(hx, hy, headR * 1.1, headR * 0.88, -0.55, 0, Math.PI * 2)
      ctx.fill()
      // Short hook from each head into the stem.
      if (i > 0) {
        ctx.beginPath()
        ctx.moveTo(hx + headR * 0.45, hy)
        ctx.quadraticCurveTo(x + gap * 0.45, hy + gap * 0.2, x + gap * 0.35, hy + gap * 0.45)
        ctx.stroke()
      }
    }
    dotY = mid
  }

  for (let i = 0; i < dots; i++) {
    ctx.beginPath()
    ctx.arc(x + gap * 0.95 + i * gap * 0.35, dotY, Math.max(1.2, gap * 0.12), 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawFlags(
  ctx: CanvasRenderingContext2D,
  stemX: number,
  stemTipY: number,
  up: boolean,
  dur: RhythmDur,
  gap: number,
  ink: [number, number, number],
) {
  const count = dur === '16' ? 2 : dur === '8' ? 1 : 0
  if (!count) return
  ctx.strokeStyle = rgba(ink, 0.95)
  ctx.lineWidth = Math.max(1.2, gap * 0.14)
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const y0 = stemTipY + (up ? 1 : -1) * i * gap * 0.45
    const y1 = y0 + (up ? 1 : -1) * gap * 0.95
    ctx.beginPath()
    ctx.moveTo(stemX, y0)
    ctx.quadraticCurveTo(
      stemX + (up ? 1 : -1) * gap * 1.05,
      y0 + (up ? 1 : -1) * gap * 0.35,
      stemX + (up ? 1 : -1) * gap * 0.15,
      y1,
    )
    ctx.stroke()
  }
}

function drawBeamGroup(
  ctx: CanvasRenderingContext2D,
  points: Array<{ stemX: number; tipY: number; dur: RhythmDur }>,
  up: boolean,
  gap: number,
  ink: [number, number, number],
) {
  if (points.length < 2) return
  const y0 = points[0].tipY
  const y1 = points[points.length - 1].tipY
  ctx.strokeStyle = rgba(ink, 0.95)
  ctx.lineWidth = Math.max(2.2, gap * 0.28)
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.moveTo(points[0].stemX, y0)
  ctx.lineTo(points[points.length - 1].stemX, y1)
  ctx.stroke()
  // Second beam for sixteenths
  if (points.some((p) => p.dur === '16')) {
    const offset = (up ? 1 : -1) * gap * 0.38
    ctx.lineWidth = Math.max(1.6, gap * 0.2)
    ctx.beginPath()
    let started = false
    for (let i = 0; i < points.length; i++) {
      if (points[i].dur !== '16') {
        started = false
        continue
      }
      // Interpolate along the main beam, offset for the 16th beam.
      const t = i / Math.max(1, points.length - 1)
      const by = y0 + (y1 - y0) * t + offset
      if (!started) {
        ctx.moveTo(points[i].stemX, by)
        started = true
      } else {
        ctx.lineTo(points[i].stemX, by)
      }
    }
    ctx.stroke()
  }
}

type DrawnNote = {
  event: RhythmEvent
  x: number
  ys: number[]
  stemUp: boolean
  stemX: number
  tipY: number
  active: boolean
  ink: [number, number, number]
}

function drawRhythmStaff(
  ctx: CanvasRenderingContext2D,
  events: RhythmEvent[],
  opts: {
    clef: 'treble' | 'bass'
    staffTop: number
    gap: number
    fifths: number
    measureX: number
    measureW: number
    measureTicks: number
    measureStart: number
    beat: number
    time: number
    showNames: boolean
    theme: SheetPalette
  },
) {
  const {
    clef,
    staffTop,
    gap,
    fifths,
    measureX,
    measureW,
    measureTicks,
    measureStart,
    beat,
    time,
    showNames,
    theme,
  } = opts
  const grid = beat / 4
  const drawn: DrawnNote[] = []
  const rw = gap * 0.62
  const rh = gap * 0.4
  // Keep the first note/rest clear of the left barline (and a little room on the right).
  const padL = Math.max(gap * 1.25, measureW * 0.1)
  const padR = Math.max(gap * 0.55, measureW * 0.045)
  const innerW = Math.max(gap * 4, measureW - padL - padR)

  for (const event of events) {
    const x = measureX + padL + (event.tick / measureTicks) * innerW
    const startT = measureStart + event.tick * grid
    const endT = startT + event.ticks * grid
    const active = time >= startT && time < endT

    if (!event.midis || event.midis.length === 0) {
      drawRest(ctx, x, staffTop, gap, event.dur, event.dots, active, theme)
      continue
    }

    const color = event.color ?? [200, 120, 80]
    const ink = inkColor(color, theme)
    const ys = event.midis.map((midi) => pitchY(midi, clef, staffTop, gap, fifths))
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2
    const stemUp = midY >= staffTop + gap * 2
    const stemX = stemUp ? x + rw * 0.78 : x - rw * 0.78
    const extremeY = stemUp ? Math.min(...ys) : Math.max(...ys)
    const tipY = extremeY + (stemUp ? -gap * 2.55 : gap * 2.55)

    for (let i = 0; i < event.midis.length; i++) {
      const midi = event.midis[i]
      const y = ys[i]
      drawLedger(ctx, x, midi, clef, staffTop, gap, fifths, theme)
      const accidental = noteAccidental(midi, fifths)
      if (accidental) {
        ctx.fillStyle = rgba(ink, active ? 1 : 0.9)
        ctx.font = `700 ${Math.round(gap * 1.25)}px "Times New Roman", Georgia, serif`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(accidental === 'b' ? '♭' : '#', x - rw - 2, y)
      }
      ctx.beginPath()
      ctx.ellipse(x, y, rw, rh, -0.35, 0, Math.PI * 2)
      const open = event.dur === 'w' || event.dur === 'h'
      if (open) {
        ctx.strokeStyle = rgba(ink, active ? 1 : 0.9)
        ctx.lineWidth = Math.max(1.4, gap * 0.16)
        ctx.stroke()
        if (event.dur === 'w') {
          // Whole notes have no stem; slightly thicker oval.
        }
      } else {
        ctx.fillStyle = rgba(ink, active ? 1 : 0.9)
        ctx.fill()
      }
      if (active) {
        ctx.strokeStyle = theme.noteInkScale < 1 ? rgba(color, 0.95) : theme.activeRing
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
      if (showNames) {
        ctx.fillStyle = theme.label
        ctx.font = `600 ${Math.max(8, Math.round(gap * 0.75))}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(noteLabel(midi, false), x, y - rh - 1)
      }
    }

    for (let d = 0; d < event.dots; d++) {
      const dy = ys[ys.length - 1]
      ctx.fillStyle = rgba(ink, 0.95)
      ctx.beginPath()
      ctx.arc(x + rw + gap * 0.35 + d * gap * 0.32, dy, Math.max(1.2, gap * 0.12), 0, Math.PI * 2)
      ctx.fill()
    }

    if (event.dur !== 'w') {
      ctx.strokeStyle = rgba(ink, 0.95)
      ctx.lineWidth = Math.max(1.15, gap * 0.12)
      ctx.beginPath()
      // Stem from the far side of the chord toward the tip.
      const fromY = stemUp ? Math.max(...ys) : Math.min(...ys)
      ctx.moveTo(stemX, fromY)
      ctx.lineTo(stemX, tipY)
      ctx.stroke()
    }

    drawn.push({ event, x, ys, stemUp, stemX, tipY, active, ink })
  }

  // Beams for consecutive beamable notes with same stem direction.
  let group: DrawnNote[] = []
  const flush = () => {
    if (group.length >= 2 && group.every((n) => n.stemUp === group[0].stemUp)) {
      drawBeamGroup(
        ctx,
        group.map((n) => ({ stemX: n.stemX, tipY: n.tipY, dur: n.event.dur })),
        group[0].stemUp,
        gap,
        group[0].ink,
      )
    } else if (group.length === 1) {
      const n = group[0]
      drawFlags(ctx, n.stemX, n.tipY, n.stemUp, n.event.dur, gap, n.ink)
    } else {
      for (const n of group) drawFlags(ctx, n.stemX, n.tipY, n.stemUp, n.event.dur, gap, n.ink)
    }
    group = []
  }
  for (const note of drawn) {
    if (note.event.beamable) group.push(note)
    else {
      flush()
    }
  }
  flush()
}

function drawSystemFrame(
  ctx: CanvasRenderingContext2D,
  originY: number,
  layout: PageLayout,
  systemIndex: number,
  active: boolean,
  theme: SheetPalette,
  showTempo: boolean,
) {
  const {
    gap,
    staffLeft,
    staffRight,
    clefLeft,
    contentLeft,
    contentW,
    measuresPerSystem,
    systemSec,
    fifths,
    bpm,
    timeSig,
    timeSigX,
  } = layout
  const trebleTop = originY + gap * 0.85
  const bassTop = trebleTop + gap * 4 + gap * 2.6
  const bassBottom = bassTop + gap * 4
  const keySigX = clefLeft + Math.max(28, gap * 3.6)
  const measureW = contentW / measuresPerSystem
  const firstMeasure = systemIndex * measuresPerSystem + 1

  if (active) {
    ctx.fillStyle = theme.activeWash
    ctx.fillRect(staffLeft - 4, originY, staffRight - staffLeft + 8, bassBottom - originY + gap * 0.8)
  }

  drawBrace(ctx, staffLeft - 2, trebleTop, bassBottom, theme)
  drawStaffLines(ctx, trebleTop, gap, staffLeft + 8, staffRight, theme)
  drawStaffLines(ctx, bassTop, gap, staffLeft + 8, staffRight, theme)
  drawClef(ctx, trebleTop, gap, clefLeft, 'treble', theme)
  drawClef(ctx, bassTop, gap, clefLeft, 'bass', theme)
  drawKeySignature(ctx, trebleTop, gap, keySigX, 'treble', fifths, theme)
  drawKeySignature(ctx, bassTop, gap, keySigX, 'bass', fifths, theme)
  drawTimeSignature(ctx, trebleTop, gap, timeSigX + gap * 0.95, timeSig, theme)
  drawTimeSignature(ctx, bassTop, gap, timeSigX + gap * 0.95, timeSig, theme)

  if (showTempo) {
    drawTempoMark(ctx, staffLeft + 6, trebleTop - gap * 0.55, bpm, theme, gap)
  }

  // Measure barlines + numbers (bars follow detected meter × BPM).
  ctx.font = `600 ${Math.max(9, Math.round(gap * 1.05))}px "Times New Roman", Georgia, serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (let m = 0; m < measuresPerSystem; m++) {
    const x = contentLeft + m * measureW
    if (m > 0) {
      ctx.strokeStyle = theme.barStrong
      ctx.lineWidth = 1.15
      ctx.beginPath()
      ctx.moveTo(x, trebleTop - gap * 0.25)
      ctx.lineTo(x, bassBottom + gap * 0.25)
      ctx.stroke()
    }
    ctx.fillStyle = theme.label
    ctx.fillText(String(firstMeasure + m), x + 3, trebleTop - gap * 0.12)
  }

  ctx.strokeStyle = theme.barStrong
  ctx.lineWidth = 1.35
  ctx.beginPath()
  ctx.moveTo(staffRight, trebleTop)
  ctx.lineTo(staffRight, bassBottom)
  ctx.stroke()

  return { trebleTop, bassTop, bassBottom, systemStart: systemIndex * systemSec }
}

type SheetModel = {
  bpm: number
  timeSig: TimeSignature
  fifths: number
  beat: number
  measureTicks: number
  rightChords: ReturnType<typeof groupChords>
  leftChords: ReturnType<typeof groupChords>
  tEnd: number
}

function buildSheetModel(notes: NoteEvent[]): SheetModel {
  const key = detectKeySignature(notes)
  const bpm = estimateBpm(notes)
  const timeSig = detectTimeSignature(notes, bpm)
  const beat = 60 / bpm
  return {
    bpm,
    timeSig,
    fifths: key.fifths,
    beat,
    measureTicks: measureSixteenthTicks(timeSig),
    rightChords: groupChords(notes, 'right', beat),
    leftChords: groupChords(notes, 'left', beat),
    tEnd: notes.length ? Math.max(...notes.map((note) => note.end)) : 0,
  }
}

type MeasureEvents = { treble: ReturnType<typeof rhythmEventsForMeasure>; bass: ReturnType<typeof rhythmEventsForMeasure> }

/** Live view: freeze analysis so notation does not morph while the playhead moves. */
type LiveSheetCache = {
  notes: NoteEvent[]
  notesLen: number
  widthBucket: number
  model: SheetModel
  measuresPerSystem: number
  eventsByMeasure: Map<number, MeasureEvents>
}

let liveSheetCache: LiveSheetCache | null = null

function liveSheetContext(
  notes: NoteEvent[],
  w: number,
  areaH: number,
  systems: number,
): { model: SheetModel; layout: PageLayout; eventsByMeasure: Map<number, MeasureEvents> } {
  const widthBucket = Math.round(w / 48)
  const hit =
    liveSheetCache &&
    liveSheetCache.notes === notes &&
    liveSheetCache.notesLen === notes.length &&
    liveSheetCache.widthBucket === widthBucket

  if (!hit) {
    const model = buildSheetModel(notes)
    const layout = pageLayout(w, areaH, model.fifths, model.bpm, model.timeSig, systems)
    const fresh: LiveSheetCache = {
      notes,
      notesLen: notes.length,
      widthBucket,
      model,
      measuresPerSystem: layout.measuresPerSystem,
      eventsByMeasure: new Map(),
    }
    liveSheetCache = fresh
    return { model, layout, eventsByMeasure: fresh.eventsByMeasure }
  }

  const cached = liveSheetCache!
  const layout = pageLayout(
    w,
    areaH,
    cached.model.fifths,
    cached.model.bpm,
    cached.model.timeSig,
    systems,
    cached.measuresPerSystem,
  )
  return {
    model: cached.model,
    layout,
    eventsByMeasure: cached.eventsByMeasure,
  }
}

function eventsForMeasure(
  cache: Map<number, MeasureEvents>,
  model: SheetModel,
  measureIndex: number,
  measureStart: number,
): MeasureEvents {
  const existing = cache.get(measureIndex)
  if (existing) return existing
  const next: MeasureEvents = {
    treble: rhythmEventsForMeasure(model.rightChords, measureStart, model.beat, model.timeSig),
    bass: rhythmEventsForMeasure(model.leftChords, measureStart, model.beat, model.timeSig),
  }
  cache.set(measureIndex, next)
  return next
}

function drawSystemsBlock(
  ctx: CanvasRenderingContext2D,
  model: SheetModel,
  layout: PageLayout,
  opts: {
    firstSystem: number
    rows: number
    showNames: boolean
    theme: SheetPalette
    playTime: number | null
    highlightCursor: boolean
    eventsByMeasure?: Map<number, MeasureEvents>
  },
) {
  const { gap, topPad, systemH, contentLeft, contentW, measuresPerSystem, measureSec, systemSec, fifths } =
    layout
  const { beat, measureTicks } = model
  const measureW = contentW / measuresPerSystem
  const time = opts.playTime
  const currentSystem = time == null ? -1 : Math.floor(Math.max(0, time) / systemSec)
  const frac = time == null ? 0 : Math.max(0, time) / systemSec - currentSystem

  for (let row = 0; row < opts.rows; row++) {
    const systemIndex = opts.firstSystem + row
    if (systemIndex < 0) continue
    const originY = topPad + row * systemH
    const isCursor = opts.highlightCursor && systemIndex === currentSystem
    const frame = drawSystemFrame(
      ctx,
      originY,
      layout,
      systemIndex,
      isCursor,
      opts.theme,
      row === 0,
    )
    const systemStart = frame.systemStart

    for (let m = 0; m < measuresPerSystem; m++) {
      const measureIndex = systemIndex * measuresPerSystem + m
      const measureStart = systemStart + m * measureSec
      const measureX = contentLeft + m * measureW
      const events = opts.eventsByMeasure
        ? eventsForMeasure(opts.eventsByMeasure, model, measureIndex, measureStart)
        : {
            treble: rhythmEventsForMeasure(model.rightChords, measureStart, model.beat, model.timeSig),
            bass: rhythmEventsForMeasure(model.leftChords, measureStart, model.beat, model.timeSig),
          }
      drawRhythmStaff(ctx, events.treble, {
        clef: 'treble',
        staffTop: frame.trebleTop,
        gap,
        fifths,
        measureX,
        measureW,
        measureTicks,
        measureStart,
        beat,
        time: time ?? -1,
        showNames: opts.showNames,
        theme: opts.theme,
      })
      drawRhythmStaff(ctx, events.bass, {
        clef: 'bass',
        staffTop: frame.bassTop,
        gap,
        fifths,
        measureX,
        measureW,
        measureTicks,
        measureStart,
        beat,
        time: time ?? -1,
        showNames: opts.showNames,
        theme: opts.theme,
      })
    }

    if (isCursor && time != null) {
      const playX = contentLeft + frac * contentW
      const glow = ctx.createLinearGradient(playX - 14, 0, playX + 14, 0)
      glow.addColorStop(0, 'rgba(255,122,50,0)')
      glow.addColorStop(0.5, 'rgba(255,122,50,0.32)')
      glow.addColorStop(1, 'rgba(255,122,50,0)')
      ctx.fillStyle = glow
      ctx.fillRect(playX - 14, frame.trebleTop - gap * 0.5, 28, frame.bassBottom - frame.trebleTop + gap)
      ctx.strokeStyle = 'rgba(255,150,80,0.95)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(playX, frame.trebleTop - gap * 0.4)
      ctx.lineTo(playX, frame.bassBottom + gap * 0.4)
      ctx.stroke()
    }
  }
}

/**
 * Draw wrapped grand-staff systems filling the area above the keyboard.
 * No scrolling: the playhead walks system by system. When it reaches the
 * penultimate visible system, that system jumps to the top of the page.
 */
export function drawScrollingSheet(
  ctx: CanvasRenderingContext2D,
  notes: NoteEvent[],
  time: number,
  w: number,
  keyboardTop: number,
  showNames: boolean,
  sheetTheme: SheetTheme = 'light',
) {
  const theme = THEMES[sheetTheme === 'dark' ? 'dark' : 'light']
  const { model, layout, eventsByMeasure } = liveSheetContext(notes, w, keyboardTop - 4, 4)
  const { systems, systemSec } = layout

  const t = Math.max(0, time)
  const currentSystem = Math.floor(t / systemSec)
  // Page stays still; when the cursor enters the penultimate row, that row becomes first.
  const pageStep = Math.max(1, systems - 2)
  const pageStart = Math.floor(currentSystem / pageStep) * pageStep

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, keyboardTop)
  ctx.clip()

  ctx.fillStyle = theme.page
  ctx.fillRect(0, 0, w, keyboardTop)

  drawSystemsBlock(ctx, model, layout, {
    firstSystem: pageStart,
    rows: systems,
    showNames,
    theme,
    playTime: t,
    highlightCursor: true,
    eventsByMeasure,
  })

  ctx.restore()
}

export type SheetPrintInfo = {
  bpm: number
  timeSigLabel: string
  totalPages: number
  systemsPerPage: number
  totalSystems: number
}

/**
 * Render one print page of the scrolling sheet (always light theme) onto a canvas.
 * Same notation engine as the live view — only pagination and theme differ.
 */
export function renderSheetPrintPage(
  notes: NoteEvent[],
  opts: {
    width: number
    height: number
    pageIndex: number
    systemsPerPage?: number
    showNames?: boolean
  },
): { canvas: HTMLCanvasElement; info: SheetPrintInfo } {
  const systemsPerPage = Math.max(1, opts.systemsPerPage ?? 3)
  const model = buildSheetModel(notes)
  // Probe gap, then shrink the layout height so stems / ledger / tempo stay inside the page.
  const probe = pageLayout(opts.width, opts.height, model.fifths, model.bpm, model.timeSig, systemsPerPage)
  const overflowPad = Math.max(40, probe.gap * 4)
  // Keep system geometry identical on every page (including the last short page).
  const layout = pageLayout(
    opts.width,
    Math.max(160, opts.height - overflowPad * 2),
    model.fifths,
    model.bpm,
    model.timeSig,
    systemsPerPage,
  )
  const measureCount = Math.max(1, Math.ceil(model.tEnd / layout.measureSec))
  const totalSystems = Math.max(1, Math.ceil(measureCount / layout.measuresPerSystem))
  const totalPages = Math.max(1, Math.ceil(totalSystems / systemsPerPage))
  const pageIndex = Math.max(0, Math.min(opts.pageIndex, totalPages - 1))
  const firstSystem = pageIndex * systemsPerPage
  const rows = Math.min(systemsPerPage, totalSystems - firstSystem)
  // Vertically center the drawn systems (helps short last pages and keeps overflow in-bounds).
  const usedH = layout.topPad + rows * layout.systemH
  const offsetY = Math.max(overflowPad, (opts.height - usedH) / 2)

  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(opts.width * scale)
  canvas.height = Math.round(opts.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.scale(scale, scale)

  const theme = THEMES.light
  // Print: pure white paper (no cream wash).
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, opts.width, opts.height)

  ctx.save()
  ctx.translate(0, offsetY)
  drawSystemsBlock(ctx, model, layout, {
    firstSystem,
    rows,
    showNames: opts.showNames ?? false,
    theme,
    playTime: null,
    highlightCursor: false,
  })
  ctx.restore()

  return {
    canvas,
    info: {
      bpm: model.bpm,
      timeSigLabel: `${model.timeSig.numerator}/${model.timeSig.denominator}`,
      totalPages,
      systemsPerPage,
      totalSystems,
    },
  }
}
