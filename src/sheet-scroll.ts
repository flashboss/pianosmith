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
    page: '#f7f4ee',
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
const MEASURE_SEC = 2.4

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
  systemSec: number
  pxPerSec: number
  fifths: number
}

function pageLayout(w: number, keyboardTop: number, fifths: number): PageLayout {
  const areaH = Math.max(160, keyboardTop - 4)
  const staffLeft = 14
  const staffRight = w - 10
  const systems = 4
  const topPad = Math.max(28, Math.min(72, areaH * 0.12))
  const usableH = Math.max(120, areaH - topPad)
  const systemH = usableH / systems
  const gap = Math.max(4.2, Math.min(10, systemH / 14.5))
  const clefLeft = staffLeft + 4
  const clefWidth = Math.max(28, gap * 3.6)
  const keySigWidth = Math.abs(fifths) * gap * 0.78 + (fifths !== 0 ? gap * 0.35 : 0)
  const contentLeft = clefLeft + clefWidth + keySigWidth
  const contentW = Math.max(80, staffRight - contentLeft)
  const measuresPerSystem = Math.max(2, Math.min(4, Math.round(contentW / Math.max(110, gap * 18))))
  const systemSec = measuresPerSystem * MEASURE_SEC
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
    systemSec,
    pxPerSec,
    fifths,
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

function drawNoteHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  gap: number,
  color: [number, number, number],
  active: boolean,
  accidental: '#' | 'b' | null,
  label: string | null,
  theme: SheetPalette,
) {
  const rw = gap * 0.68
  const rh = gap * 0.45
  const scale = theme.noteInkScale
  const ink: [number, number, number] = [
    Math.round(color[0] * scale),
    Math.round(color[1] * scale),
    Math.round(color[2] * scale),
  ]
  if (accidental) {
    ctx.fillStyle = rgba(ink, active ? 1 : 0.9)
    ctx.font = `700 ${Math.round(gap * 1.25)}px "Times New Roman", Georgia, serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(accidental === 'b' ? '♭' : '#', x - rw - 1, y)
  }
  ctx.beginPath()
  ctx.ellipse(x, y, rw, rh, -0.35, 0, Math.PI * 2)
  ctx.fillStyle = rgba(ink, active ? 1 : 0.88)
  ctx.fill()
  if (active) {
    ctx.strokeStyle = theme.noteInkScale < 1 ? rgba(color, 0.95) : theme.activeRing
    ctx.lineWidth = theme.noteInkScale < 1 ? 1.6 : 1.3
    ctx.stroke()
  }
  ctx.strokeStyle = rgba(ink, active ? 1 : 0.85)
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(x + rw * 0.78, y)
  ctx.lineTo(x + rw * 0.78, y - gap * 2.4)
  ctx.stroke()
  if (label) {
    ctx.fillStyle = theme.label
    ctx.font = `600 ${Math.max(8, Math.round(gap * 0.8))}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(label, x, y - rh - 1)
  }
}

function drawSystemFrame(
  ctx: CanvasRenderingContext2D,
  originY: number,
  layout: PageLayout,
  systemIndex: number,
  active: boolean,
  theme: SheetPalette,
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
  } = layout
  const trebleTop = originY + gap * 0.85
  const bassTop = trebleTop + gap * 4 + gap * 2.6
  const bassBottom = bassTop + gap * 4
  const keySigX = clefLeft + Math.max(28, gap * 3.6)

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

  ctx.strokeStyle = theme.barSoft
  ctx.lineWidth = 1
  for (let m = 1; m < measuresPerSystem; m++) {
    const x = contentLeft + (m / measuresPerSystem) * contentW
    ctx.beginPath()
    ctx.moveTo(x, trebleTop - gap * 0.25)
    ctx.lineTo(x, bassBottom + gap * 0.25)
    ctx.stroke()
  }

  ctx.strokeStyle = theme.barStrong
  ctx.beginPath()
  ctx.moveTo(staffRight, trebleTop)
  ctx.lineTo(staffRight, bassBottom)
  ctx.stroke()

  return { trebleTop, bassTop, bassBottom, systemStart: systemIndex * systemSec }
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
  const key = detectKeySignature(notes)
  const layout = pageLayout(w, keyboardTop, key.fifths)
  const {
    gap,
    systems,
    systemH,
    topPad,
    contentLeft,
    contentW,
    systemSec,
    pxPerSec,
    staffRight,
    fifths,
  } = layout

  const t = Math.max(0, time)
  const currentSystem = Math.floor(t / systemSec)
  const frac = (t / systemSec) - currentSystem
  // Page stays still; when the cursor enters the penultimate row, that row becomes first.
  const pageStep = Math.max(1, systems - 2)
  const pageStart = Math.floor(currentSystem / pageStep) * pageStep
  const cursorRow = currentSystem - pageStart

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, keyboardTop)
  ctx.clip()

  ctx.fillStyle = theme.page
  ctx.fillRect(0, 0, w, keyboardTop)

  for (let row = 0; row < systems; row++) {
    const systemIndex = pageStart + row
    if (systemIndex < 0) continue
    const originY = topPad + row * systemH
    if (originY > keyboardTop) continue

    const frame = drawSystemFrame(ctx, originY, layout, systemIndex, row === cursorRow, theme)
    const systemStart = frame.systemStart
    const systemEnd = systemStart + systemSec

    for (const note of notes) {
      if (note.end < systemStart || note.start > systemEnd) continue
      const clef = note.hand === 'left' ? 'bass' : 'treble'
      const staffTop = clef === 'bass' ? frame.bassTop : frame.trebleTop
      const startClamped = Math.max(note.start, systemStart)
      const endClamped = Math.min(note.end, systemEnd)
      const x = contentLeft + (startClamped - systemStart) * pxPerSec
      const xEnd = contentLeft + (endClamped - systemStart) * pxPerSec
      if (x > staffRight + 10 || xEnd < contentLeft - 10) continue
      const y = pitchY(note.midi, clef, staffTop, gap, fifths)
      const active = time >= note.start && time < note.end
      drawLedger(ctx, x, note.midi, clef, staffTop, gap, fifths, theme)
      if (xEnd > x + gap * 0.6) {
        ctx.fillStyle = rgba(note.color, active ? theme.sustainActive : theme.sustainIdle)
        ctx.fillRect(x, y - gap * 0.16, Math.min(staffRight, xEnd) - x, gap * 0.32)
      }
      if (note.start >= systemStart && note.start < systemEnd) {
        drawNoteHead(
          ctx,
          x,
          y,
          gap,
          note.color,
          active,
          noteAccidental(note.midi, fifths),
          showNames ? noteLabel(note.midi, false) : null,
          theme,
        )
      }
    }

    if (row === cursorRow) {
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

  ctx.restore()
}
