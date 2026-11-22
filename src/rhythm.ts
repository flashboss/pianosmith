import { measureSixteenthTicks, type TimeSignature } from './meter'
import type { NoteEvent } from './types'

export type Chord = { start: number; end: number; midis: number[]; color: [number, number, number] }
export type Segment = { ticks: number; midis: number[] | null; color: [number, number, number] | null }
export type RhythmDur = 'w' | 'h' | 'q' | '8' | '16'

export type RhythmEvent = {
  /** Start tick within the measure (0-based sixteenths). */
  tick: number
  ticks: number
  midis: number[] | null
  color: [number, number, number] | null
  dur: RhythmDur
  dots: number
  beamable: boolean
}

const TICK_SIZES = [16, 12, 8, 6, 4, 3, 2, 1] as const

export function splitTicks(ticks: number): number[] {
  const out: number[] = []
  let left = Math.max(1, Math.round(ticks))
  while (left > 0) {
    const take = TICK_SIZES.find((size) => size <= left) ?? 1
    out.push(take)
    left -= take
  }
  return out
}

export function durationOf(ticks: number): { dur: RhythmDur; dots: number } {
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

export function groupChords(notes: NoteEvent[], hand: 'left' | 'right', beat: number): Chord[] {
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
      // Keep the louder / first color as representative.
    } else {
      byStart.set(start, { start, end, midis: [note.midi], color: note.color })
    }
  }
  return [...byStart.values()]
    .map((chord) => ({
      ...chord,
      midis: [...new Set(chord.midis)].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.start - b.start)
}

export function segmentsForMeasure(
  chords: Chord[],
  measureStart: number,
  beat: number,
  timeSig: TimeSignature,
): Segment[] {
  const grid = beat / 4
  const toTick = (time: number) => Math.round((time - measureStart) / grid)
  const measureTicks = measureSixteenthTicks(timeSig)
  const inside = chords
    .map((chord) => ({
      start: Math.max(0, toTick(chord.start)),
      end: Math.min(measureTicks, toTick(chord.end)),
      midis: chord.midis,
      color: chord.color,
    }))
    .filter((chord) => chord.end > chord.start && chord.start < measureTicks)

  const segments: Segment[] = []
  let cursor = 0
  for (const chord of inside) {
    if (chord.start > cursor) {
      for (const ticks of splitTicks(chord.start - cursor)) {
        segments.push({ ticks, midis: null, color: null })
      }
    }
    if (chord.start < cursor) continue
    const capped = Math.min(Math.max(1, chord.end - chord.start), measureTicks - chord.start)
    for (const ticks of splitTicks(capped)) {
      segments.push({ ticks, midis: chord.midis, color: chord.color })
    }
    cursor = chord.start + capped
  }
  if (cursor < measureTicks) {
    for (const ticks of splitTicks(measureTicks - cursor)) {
      segments.push({ ticks, midis: null, color: null })
    }
  }
  if (segments.length === 0) segments.push({ ticks: measureTicks, midis: null, color: null })
  return segments
}

/** Expand measure segments into drawable rhythmic events with absolute tick starts. */
export function rhythmEventsForMeasure(
  chords: Chord[],
  measureStart: number,
  beat: number,
  timeSig: TimeSignature,
): RhythmEvent[] {
  const segments = segmentsForMeasure(chords, measureStart, beat, timeSig)
  const events: RhythmEvent[] = []
  let tick = 0
  for (const segment of segments) {
    for (const part of splitTicks(segment.ticks)) {
      const { dur, dots } = durationOf(part)
      events.push({
        tick,
        ticks: part,
        midis: segment.midis,
        color: segment.color,
        dur,
        dots,
        beamable: Boolean(segment.midis?.length) && (dur === '8' || dur === '16'),
      })
      tick += part
    }
  }
  return events
}
