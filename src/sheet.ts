import { jsPDF } from 'jspdf'
import VexFlow, {
  Accidental,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
} from 'vexflow/bravura'
import type { NoteEvent } from './types'

const LETTERS = ['c', 'c', 'd', 'd', 'e', 'f', 'f', 'g', 'g', 'a', 'a', 'b'] as const
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false]
const TICK_SIZES = [16, 12, 8, 6, 4, 3, 2, 1] as const

type Chord = { start: number; end: number; midis: number[] }
type Segment = { ticks: number; midis: number[] | null }

function midiToKey(midi: number): { key: string; accidental: '#' | null } {
  const m = Math.max(21, Math.min(108, Math.round(midi)))
  const pc = ((m % 12) + 12) % 12
  const octave = Math.floor(m / 12) - 1
  return {
    key: `${LETTERS[pc]}/${octave}`,
    accidental: SHARP[pc] ? '#' : null,
  }
}

function estimateBpm(notes: NoteEvent[]): number {
  const starts = [...new Set(notes.map((note) => note.start))].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1]
    if (gap > 0.08 && gap < 1.8) gaps.push(gap)
  }
  if (gaps.length < 3) return 100
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  const bpm = Math.round(60 / (median * 2) / 5) * 5
  return Math.max(56, Math.min(152, bpm))
}

function splitTicks(ticks: number): number[] {
  const out: number[] = []
  let left = Math.max(1, Math.round(ticks))
  while (left > 0) {
    const take = TICK_SIZES.find((size) => size <= left) ?? 1
    out.push(take)
    left -= take
  }
  return out
}

function durationOf(ticks: number): { dur: string; dots: number } {
  switch (ticks) {
    case 1:
      return { dur: '16', dots: 0 }
    case 2:
      return { dur: '8', dots: 0 }
    case 3:
      return { dur: '8', dots: 1 }
    case 4:
      return { dur: 'q', dots: 0 }
    case 6:
      return { dur: 'q', dots: 1 }
    case 8:
      return { dur: 'h', dots: 0 }
    case 12:
      return { dur: 'h', dots: 1 }
    case 16:
      return { dur: 'w', dots: 0 }
    default:
      return { dur: '16', dots: 0 }
  }
}

function groupChords(notes: NoteEvent[], hand: 'left' | 'right', beat: number): Chord[] {
  const grid = beat / 4
  const byStart = new Map<number, Chord>()
  for (const note of notes) {
    if (note.hand !== hand) continue
    const start = Math.round(note.start / grid) * grid
    const end = Math.max(start + grid, Math.round(note.end / grid) * grid)
    const existing = byStart.get(start)
    if (existing) {
      existing.midis.push(note.midi)
      existing.end = Math.max(existing.end, end)
    } else {
      byStart.set(start, { start, end, midis: [note.midi] })
    }
  }
  return [...byStart.values()]
    .map((chord) => ({
      ...chord,
      midis: [...new Set(chord.midis)].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.start - b.start)
}

function segmentsForMeasure(chords: Chord[], measureStart: number, beat: number): Segment[] {
  const grid = beat / 4
  const toTick = (time: number) => Math.round((time - measureStart) / grid)
  const measureTicks = 16
  const inside = chords
    .map((chord) => ({
      start: Math.max(0, toTick(chord.start)),
      end: Math.min(measureTicks, toTick(chord.end)),
      midis: chord.midis,
    }))
    .filter((chord) => chord.end > chord.start && chord.start < measureTicks)

  const segments: Segment[] = []
  let cursor = 0
  for (const chord of inside) {
    if (chord.start > cursor) {
      for (const ticks of splitTicks(chord.start - cursor)) segments.push({ ticks, midis: null })
    }
    if (chord.start < cursor) continue
    const capped = Math.min(Math.max(1, chord.end - chord.start), measureTicks - chord.start)
    for (const ticks of splitTicks(capped)) segments.push({ ticks, midis: chord.midis })
    cursor = chord.start + capped
  }
  if (cursor < measureTicks) {
    for (const ticks of splitTicks(measureTicks - cursor)) segments.push({ ticks, midis: null })
  }
  if (segments.length === 0) segments.push({ ticks: 16, midis: null })
  return segments
}

function makeTickables(segments: Segment[], clef: 'treble' | 'bass') {
  const notes: StaveNote[] = []
  const restKey = clef === 'treble' ? 'b/4' : 'd/3'
  for (const segment of segments) {
    for (const ticks of splitTicks(segment.ticks)) {
      const { dur, dots } = durationOf(ticks)
      if (!segment.midis || segment.midis.length === 0) {
        const rest = new StaveNote({ keys: [restKey], duration: `${dur}r` })
        for (let i = 0; i < dots; i++) Dot.buildAndAttach([rest], { all: true })
        notes.push(rest)
        continue
      }
      const infos = segment.midis.map(midiToKey)
      const note = new StaveNote({ keys: infos.map((info) => info.key), duration: dur })
      infos.forEach((info, index) => {
        if (info.accidental) note.addModifier(new Accidental(info.accidental), index)
      })
      for (let i = 0; i < dots; i++) Dot.buildAndAttach([note], { all: true })
      notes.push(note)
    }
  }
  return notes
}

function beamNotes(notes: StaveNote[]) {
  const group: StaveNote[] = []
  const beams: Beam[] = []
  const flush = () => {
    if (group.length >= 2) beams.push(new Beam(group.slice()))
    group.length = 0
  }
  for (const note of notes) {
    const dur = note.getDuration()
    const beamable = !note.isRest() && (dur === '8' || dur === '16')
    if (beamable) group.push(note)
    else flush()
  }
  flush()
  return beams
}

async function waitForFonts() {
  VexFlow.setFonts('Bravura', 'Academico')
  try {
    await Promise.all([
      document.fonts.load('400 48px Bravura'),
      document.fonts.load('400 24px Academico'),
      document.fonts.load('700 24px Academico'),
    ])
    await document.fonts.ready
  } catch {
    /* ignore */
  }
  // Ensure glyph metrics are warm before the first stave draw.
  await new Promise((resolve) => window.setTimeout(resolve, 120))
}

function drawSystem(
  context: ReturnType<Renderer['getContext']>,
  opts: {
    x: number
    y: number
    width: number
    measures: number
    firstMeasure: number
    measureCount: number
    t0: number
    measureSec: number
    beat: number
    rightChords: Chord[]
    leftChords: Chord[]
  },
) {
  const {
    x: originX,
    y: originY,
    width,
    measures,
    firstMeasure,
    measureCount,
    t0,
    measureSec,
    beat,
    rightChords,
    leftChords,
  } = opts
  const measureW = width / measures
  const trebleY = originY
  const bassY = originY + 110

  for (let i = 0; i < measures; i++) {
    const measure = firstMeasure + i
    if (measure >= measureCount) break
    const measureStart = t0 + measure * measureSec
    const x = originX + i * measureW
    const treble = new Stave(x, trebleY, measureW, { spaceAboveStaffLn: 3, spaceBelowStaffLn: 2 })
    const bass = new Stave(x, bassY, measureW, { spaceAboveStaffLn: 2, spaceBelowStaffLn: 5 })

    // Every system starts with both clefs.
    if (i === 0) {
      treble.addClef('treble')
      bass.addClef('bass')
      if (measure === 0) {
        treble.addTimeSignature('4/4')
        bass.addTimeSignature('4/4')
      }
    }

    treble.setContext(context).draw()
    bass.setContext(context).draw()
    if (i === 0) {
      new StaveConnector(treble, bass).setType('brace').setContext(context).draw()
      new StaveConnector(treble, bass).setType('singleLeft').setContext(context).draw()
    }
    new StaveConnector(treble, bass).setType('singleRight').setContext(context).draw()

    const trebleNotes = makeTickables(segmentsForMeasure(rightChords, measureStart, beat), 'treble')
    const bassNotes = makeTickables(segmentsForMeasure(leftChords, measureStart, beat), 'bass')
    const trebleVoice = new Voice({ numBeats: 4, beatValue: 4 }).setStrict(false).addTickables(trebleNotes)
    const bassVoice = new Voice({ numBeats: 4, beatValue: 4 }).setStrict(false).addTickables(bassNotes)
    new Formatter().joinVoices([trebleVoice]).formatToStave([trebleVoice], treble)
    new Formatter().joinVoices([bassVoice]).formatToStave([bassVoice], bass)
    trebleVoice.draw(context, treble)
    bassVoice.draw(context, bass)
    for (const beam of [...beamNotes(trebleNotes), ...beamNotes(bassNotes)]) {
      beam.setContext(context).draw()
    }
  }
}

/**
 * Build a landscape A4 PDF of a simplified grand-staff transcription (4/4).
 */
export async function songToSheetPdf(notes: NoteEvent[], title: string): Promise<Blob> {
  if (notes.length === 0) throw new Error('Nessuna nota da mettere sullo spartito')
  await waitForFonts()

  const bpm = estimateBpm(notes)
  const beat = 60 / bpm
  const t0 = Math.min(...notes.map((note) => note.start))
  const t1 = Math.max(...notes.map((note) => note.end))
  const measureSec = beat * 4
  const measureCount = Math.max(1, Math.ceil((t1 - t0) / measureSec))
  const rightChords = groupChords(notes, 'right', beat)
  const leftChords = groupChords(notes, 'left', beat)

  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()

  // Content box inset from the physical page — avoids right/bottom clipping in viewers.
  const marginX = 72
  const marginTop = 50
  const marginBottom = 40
  const contentW = pageW - marginX * 2
  const contentH = pageH - marginTop - marginBottom
  const systemH = 250
  const systemsPerPage = Math.max(1, Math.floor(contentH / systemH))
  const measuresPerSystem = 3
  const systemCount = Math.ceil(measureCount / measuresPerSystem)
  const scale = 2

  // Visible offscreen host: overflow:hidden + 1×1px breaks canvas font glyph rasterization.
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;overflow:visible;'
  document.body.appendChild(host)

  try {
    for (let pageStart = 0; pageStart < systemCount; pageStart += systemsPerPage) {
      if (pageStart > 0) pdf.addPage('a4', 'landscape')
      const pageIndex = Math.floor(pageStart / systemsPerPage)
      const systemsHere = Math.min(systemsPerPage, systemCount - pageStart)

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(pageIndex === 0 ? 16 : 11)
      pdf.text(title || 'PianoSmith', pageW / 2, 28, { align: 'center' })
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(9)
      pdf.text(`${bpm} BPM  |  4/4  |  pag. ${pageIndex + 1}`, marginX, 28)

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(contentW * scale)
      canvas.height = Math.round(systemsHere * systemH * scale)
      host.appendChild(canvas)

      const renderer = new Renderer(canvas, Renderer.Backends.CANVAS)
      renderer.resize(canvas.width, canvas.height)
      const context = renderer.getContext()
      context.scale(scale, scale)

      for (let s = 0; s < systemsHere; s++) {
        const system = pageStart + s
        const firstMeasure = system * measuresPerSystem
        const measuresHere = Math.min(measuresPerSystem, measureCount - firstMeasure)
        drawSystem(context, {
          x: 0,
          y: s * systemH + 20,
          width: contentW,
          measures: measuresHere,
          firstMeasure,
          measureCount,
          t0,
          measureSec,
          beat,
          rightChords,
          leftChords,
        })
      }

      const img = canvas.toDataURL('image/png')
      pdf.addImage(img, 'PNG', marginX, marginTop, contentW, systemsHere * systemH)
      host.removeChild(canvas)
    }
  } finally {
    host.remove()
  }

  return pdf.output('blob')
}
