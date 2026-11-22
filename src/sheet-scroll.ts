import type { NoteEvent } from './types'
import { noteLabel, rgba } from './theory'

/** Live scrolling grand-staff view with line wraps filling the page. */

const LETTER_STEPS = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6] as const
const SHARP_PC = [false, true, false, true, false, false, true, false, true, false, true, false]
const MEASURE_SEC = 2.4

function diatonicFromC0(midi: number): number {
  const m = Math.max(12, Math.min(108, Math.round(midi)))
  const octave = Math.floor(m / 12) - 1
  const pc = ((m % 12) + 12) % 12
  return octave * 7 + LETTER_STEPS[pc]
}

function isSharp(midi: number): boolean {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  return SHARP_PC[pc]
}

function pitchY(midi: number, clef: 'treble' | 'bass', staffTop: number, gap: number): number {
  const ref = clef === 'treble' ? diatonicFromC0(64) : diatonicFromC0(43)
  const steps = diatonicFromC0(midi) - ref
  return staffTop + 4 * gap - steps * (gap / 2)
}

function needsLedger(midi: number, clef: 'treble' | 'bass'): number[] {
  const yRef = clef === 'treble' ? 64 : 43
  const topRef = clef === 'treble' ? 77 : 57
  const d = diatonicFromC0(midi)
  const dLo = diatonicFromC0(yRef)
  const dHi = diatonicFromC0(topRef)
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
  contentLeft: number
  contentW: number
  measuresPerSystem: number
  systemSec: number
  pxPerSec: number
}

function pageLayout(w: number, keyboardTop: number): PageLayout {
  const areaH = Math.max(160, keyboardTop - 4)
  const staffLeft = 14
  const staffRight = w - 10
  // Always four systems; leave headroom so the first starts lower on the page.
  const systems = 4
  const topPad = Math.max(28, Math.min(72, areaH * 0.12))
  const usableH = Math.max(120, areaH - topPad)
  const systemH = usableH / systems
  const gap = Math.max(4.2, Math.min(10, systemH / 14.5))
  const contentLeft = staffLeft + Math.max(30, gap * 4.2)
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
    contentLeft,
    contentW,
    measuresPerSystem,
    systemSec,
    pxPerSec,
  }
}

function drawStaff(
  ctx: CanvasRenderingContext2D,
  top: number,
  gap: number,
  left: number,
  right: number,
  clef: 'treble' | 'bass',
) {
  ctx.strokeStyle = 'rgba(20,20,20,0.85)'
  ctx.lineWidth = 1.15
  for (let i = 0; i < 5; i++) {
    const y = top + i * gap
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(15,15,15,0.95)'
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

function drawBrace(ctx: CanvasRenderingContext2D, x: number, trebleTop: number, bassBottom: number) {
  const mid = (trebleTop + bassBottom) / 2
  ctx.strokeStyle = 'rgba(15,15,15,0.92)'
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
) {
  const ref = clef === 'treble' ? 64 : 43
  ctx.strokeStyle = 'rgba(20,20,20,0.8)'
  ctx.lineWidth = 1.1
  for (const step of needsLedger(midi, clef)) {
    const y = staffTop + 4 * gap - (step - diatonicFromC0(ref)) * (gap / 2)
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
  sharp: boolean,
  label: string | null,
) {
  const rw = gap * 0.68
  const rh = gap * 0.45
  // Hand tint kept, but ink-dark on white paper.
  const ink: [number, number, number] = [
    Math.round(color[0] * 0.42),
    Math.round(color[1] * 0.42),
    Math.round(color[2] * 0.42),
  ]
  if (sharp) {
    ctx.fillStyle = rgba(ink, active ? 1 : 0.9)
    ctx.font = `700 ${Math.round(gap * 1.25)}px system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('#', x - rw - 1, y)
  }
  ctx.beginPath()
  ctx.ellipse(x, y, rw, rh, -0.35, 0, Math.PI * 2)
  ctx.fillStyle = rgba(ink, active ? 1 : 0.88)
  ctx.fill()
  if (active) {
    ctx.strokeStyle = rgba(color, 0.95)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
  ctx.strokeStyle = rgba(ink, active ? 1 : 0.85)
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(x + rw * 0.78, y)
  ctx.lineTo(x + rw * 0.78, y - gap * 2.4)
  ctx.stroke()
  if (label) {
    ctx.fillStyle = 'rgba(20,20,20,0.9)'
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
) {
  const { gap, staffLeft, staffRight, contentLeft, contentW, measuresPerSystem, systemSec } = layout
  const trebleTop = originY + gap * 0.85
  const bassTop = trebleTop + gap * 4 + gap * 2.6
  const bassBottom = bassTop + gap * 4

  if (active) {
    ctx.fillStyle = 'rgba(255,122,50,0.08)'
    ctx.fillRect(staffLeft - 4, originY, staffRight - staffLeft + 8, bassBottom - originY + gap * 0.8)
  }

  drawBrace(ctx, staffLeft - 2, trebleTop, bassBottom)
  drawStaff(ctx, trebleTop, gap, contentLeft - 26, staffRight, 'treble')
  drawStaff(ctx, bassTop, gap, contentLeft - 26, staffRight, 'bass')

  ctx.strokeStyle = 'rgba(30,30,30,0.22)'
  ctx.lineWidth = 1
  for (let m = 1; m < measuresPerSystem; m++) {
    const x = contentLeft + (m / measuresPerSystem) * contentW
    ctx.beginPath()
    ctx.moveTo(x, trebleTop - gap * 0.25)
    ctx.lineTo(x, bassBottom + gap * 0.25)
    ctx.stroke()
  }

  // Right barline
  ctx.strokeStyle = 'rgba(20,20,20,0.75)'
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
) {
  const layout = pageLayout(w, keyboardTop)
  const { gap, systems, systemH, topPad, contentLeft, contentW, systemSec, pxPerSec, staffRight } =
    layout

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

  ctx.fillStyle = '#f7f4ee'
  ctx.fillRect(0, 0, w, keyboardTop)

  for (let row = 0; row < systems; row++) {
    const systemIndex = pageStart + row
    if (systemIndex < 0) continue
    const originY = topPad + row * systemH
    if (originY > keyboardTop) continue

    const frame = drawSystemFrame(ctx, originY, layout, systemIndex, row === cursorRow)
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
      const y = pitchY(note.midi, clef, staffTop, gap)
      const active = time >= note.start && time < note.end
      drawLedger(ctx, x, note.midi, clef, staffTop, gap)
      if (xEnd > x + gap * 0.6) {
        ctx.fillStyle = rgba(note.color, active ? 0.22 : 0.12)
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
          isSharp(note.midi),
          showNames ? noteLabel(note.midi, false) : null,
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
