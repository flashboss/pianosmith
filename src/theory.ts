import type { Hand, NoteEvent, RawNote } from './types'

const BLACK = new Set([1, 3, 6, 8, 10])

const WHITE_INDEX = new Array<number>(128)
{
  let count = 0
  for (let midi = 0; midi < 128; midi++) {
    WHITE_INDEX[midi] = count
    if (!BLACK.has(midi % 12)) count++
  }
}

const A0 = 21
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const LEFT: Array<[number, number, number]> = [
  [68, 108, 255],
  [128, 82, 255],
  [78, 156, 255],
  [176, 72, 255],
  [96, 88, 245],
]

const RIGHT: Array<[number, number, number]> = [
  [255, 72, 92],
  [255, 92, 154],
  [255, 96, 48],
  [255, 58, 132],
  [255, 146, 62],
  [230, 64, 196],
]

export function isBlack(midi: number): boolean {
  const note = Math.round(midi)
  return BLACK.has(((note % 12) + 12) % 12)
}

/** White-key index relative to A0. Black keys report the white key below them. */
export function whiteIndex(midi: number): number {
  const m = Math.max(0, Math.min(127, Math.round(midi)))
  if (isBlack(m)) return WHITE_INDEX[m] - WHITE_INDEX[A0] - 1
  return WHITE_INDEX[m] - WHITE_INDEX[A0]
}

export function noteLabel(midi: number, withOctave: boolean): string {
  const name = NAMES[((midi % 12) + 12) % 12]
  if (!withOctave) return name
  return name + (Math.floor(midi / 12) - 1)
}

export function clampMidi(midi: number): number {
  return Math.max(21, Math.min(108, Math.round(midi)))
}

function merge(notes: RawNote[]): RawNote[] {
  const groups = new Map<number, RawNote[]>()
  const sorted = [...notes].sort((a, b) => a.midi - b.midi || a.start - b.start)
  for (const note of sorted) {
    const group = groups.get(note.midi)
    const prev = group?.[group.length - 1]
    if (prev && note.start <= prev.end + 0.055) {
      prev.end = Math.max(prev.end, note.end)
      prev.velocity = Math.max(prev.velocity, note.velocity)
    } else {
      const copy = { ...note }
      if (group) group.push(copy)
      else groups.set(note.midi, [copy])
    }
  }
  return [...groups.values()].flat()
}

function desiredSplit(notes: RawNote[]): number {
  if (notes.length === 0) return 60
  const pitches = [...new Set(notes.map((note) => note.midi))].sort((a, b) => a - b)
  if (pitches.length === 1) {
    if (pitches[0] < 58) return pitches[0] + 8
    if (pitches[0] > 64) return pitches[0] - 8
    return 60
  }
  let best = 0
  let at = 0
  for (let i = 0; i < pitches.length - 1; i++) {
    const gap = pitches[i + 1] - pitches[i]
    if (gap > best) {
      best = gap
      at = i
    }
  }
  const avg = pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length
  if (best >= 4) return (pitches[at] + pitches[at + 1]) / 2
  if (avg >= 67) return pitches[0] - 1
  if (avg <= 52) return pitches[pitches.length - 1] + 1
  return pitches[Math.floor((pitches.length - 1) / 2)] + 0.5
}

export function prepareNotes(raw: RawNote[]): NoteEvent[] {
  const cleaned = merge(
    raw.filter(
      (note) =>
        note.midi >= 21 &&
        note.midi <= 108 &&
        note.end - note.start > 0.045 &&
        Number.isFinite(note.start) &&
        Number.isFinite(note.end),
    ),
  ).sort((a, b) => a.start - b.start || a.midi - b.midi)

  let split = desiredSplit(cleaned.slice(0, 16))
  let j0 = 0
  let j1 = 0
  const notes: NoteEvent[] = []

  for (let i = 0; i < cleaned.length; i++) {
    const note = cleaned[i]
    while (j0 < i && cleaned[j0].start < note.start - 1.6) j0++
    if (j1 < i) j1 = i
    while (j1 < cleaned.length && cleaned[j1].start < note.start + 0.7) j1++
    const context: RawNote[] = []
    for (let k = j0; k < j1; k++) {
      if (cleaned[k].end > note.start - 0.18) context.push(cleaned[k])
    }
    split = split * 0.62 + desiredSplit(context) * 0.38
    const hand: Hand = note.midi < split ? 'left' : 'right'
    const palette = hand === 'left' ? LEFT : RIGHT
    notes.push({
      midi: note.midi,
      start: note.start,
      end: note.end,
      velocity: Math.max(0.2, Math.min(1, note.velocity || 0.7)),
      hand,
      color: palette[note.midi % palette.length],
      hit: false,
    })
  }

  return notes
}

export function rgba(color: [number, number, number], alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`
}
