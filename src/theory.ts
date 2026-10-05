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

const WHITE_MIDIS: number[] = []
for (let midi = A0; midi <= 108; midi++) {
  if (!BLACK.has(midi % 12)) WHITE_MIDIS.push(midi)
}

/** MIDI note for a white-key index relative to A0 (clamped to the keyboard). */
export function midiAtWhiteIndex(index: number): number {
  const i = Math.max(0, Math.min(WHITE_MIDIS.length - 1, Math.round(index)))
  return WHITE_MIDIS[i]
}

export function noteLabel(midi: number, withOctave: boolean): string {
  const name = NAMES[((midi % 12) + 12) % 12]
  if (!withOctave) return name
  return name + (Math.floor(midi / 12) - 1)
}

export function clampMidi(midi: number): number {
  return Math.max(21, Math.min(108, Math.round(midi)))
}

/** Inclusive white-key span a hand may open (thumb to pinky). */
const HAND_SPAN_NOTES = 9
const HAND_OPEN = HAND_SPAN_NOTES - 1
const FINGERS_PER_HAND = 5

function spanOf(midis: number[]): number {
  if (midis.length <= 1) return 0
  const whites = midis.map((midi) => whiteIndex(midi))
  return Math.max(...whites) - Math.min(...whites)
}

function spanFits(midis: number[]): boolean {
  return midis.length <= FINGERS_PER_HAND && spanOf(midis) <= HAND_OPEN
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

type Partition = { split: number; left: number[]; right: number[] }

/** Contiguous left/right split that both hands can physically play. */
function partitionPitches(pitches: number[]): Partition | null {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b)
  if (sorted.length === 0) return { split: 60, left: [], right: [] }
  if (sorted.length === 1) {
    const pitch = sorted[0]
    if (pitch < 60) return { split: pitch + 8, left: [pitch], right: [] }
    return { split: pitch - 8, left: [], right: [pitch] }
  }
  if (spanFits(sorted)) {
    const avg = sorted.reduce((sum, pitch) => sum + pitch, 0) / sorted.length
    if (avg < 60) return { split: sorted[sorted.length - 1] + 1, left: sorted, right: [] }
    return { split: sorted[0] - 1, left: [], right: sorted }
  }

  let best: Partition | null = null
  let bestScore = -Infinity
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted.slice(0, i + 1)
    const right = sorted.slice(i + 1)
    if (!spanFits(left) || !spanFits(right)) continue
    const split = (sorted[i] + sorted[i + 1]) / 2
    const gap = sorted[i + 1] - sorted[i]
    const mid = (sorted[0] + sorted[sorted.length - 1]) / 2
    const score =
      10000 -
      Math.abs(left.length - right.length) * 40 +
      Math.min(gap, 12) * 10 -
      Math.abs(split - mid) * 1.5
    if (score > bestScore) {
      bestScore = score
      best = { split, left, right }
    }
  }
  return best
}

/**
 * Drop the fewest pitches so two hands can cover what remains.
 * Prefers dropping quiet inner fillers over outer melody notes.
 */
function playablePitches(pitches: number[], velocityOf: (midi: number) => number): Partition & { keep: number[] } {
  let sorted = [...new Set(pitches)].sort((a, b) => a - b)
  let part = partitionPitches(sorted)
  if (part) return { ...part, keep: sorted }

  while (sorted.length > 1) {
    let dropAt = -1
    let worst = Infinity
    for (let i = 0; i < sorted.length; i++) {
      // Prefer dropping inner notes; protect the outer melody pitches.
      const edge = i === 0 || i === sorted.length - 1 ? 3 : 0
      const score = velocityOf(sorted[i]) * 10 + edge
      if (score < worst) {
        worst = score
        dropAt = i
      }
    }
    if (dropAt < 0) break
    sorted = sorted.filter((_, index) => index !== dropAt)
    part = partitionPitches(sorted)
    if (part) return { ...part, keep: sorted }
  }

  const only = sorted.slice(0, 1)
  const pitch = only[0] ?? 60
  if (pitch < 60) return { split: pitch + 8, left: only, right: [], keep: only }
  return { split: pitch - 8, left: [], right: only, keep: only }
}

function colorFor(hand: Hand, midi: number): [number, number, number] {
  const palette = hand === 'left' ? LEFT : RIGHT
  return palette[midi % palette.length]
}

/** Groups of notes that ever sound together (overlap graph components). */
function overlapClusters(notes: NoteEvent[]): number[][] {
  const n = notes.length
  const parent = Array.from({ length: n }, (_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let cursor = index
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const unite = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (notes[j].start >= notes[i].end) break
      if (notes[i].end > notes[j].start && notes[j].end > notes[i].start) unite(i, j)
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const list = groups.get(root)
    if (list) list.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()]
}

/**
 * Inside one overlap cluster, every simultaneous slice must be two-hand playable.
 * Instantaneous chords that cannot be covered lose the quietest excess notes.
 */
function enforceClusterPlayable(notes: NoteEvent[], indices: number[]): void {
  const members = indices.map((index) => notes[index])
  const times = [...new Set(members.flatMap((note) => [note.start, note.end]))].sort((a, b) => a - b)
  const dropped = new Set<number>()

  for (let t = 0; t < times.length - 1; t++) {
    const stamp = (times[t] + times[t + 1]) / 2
    const sounding = indices.filter((index) => {
      if (dropped.has(index)) return false
      const note = notes[index]
      return note.start <= stamp && note.end > stamp
    })
    if (sounding.length === 0) continue

    const pitches = [...new Set(sounding.map((index) => notes[index].midi))]
    const velocityOf = (midi: number) => {
      let best = 0
      for (const index of sounding) {
        if (notes[index].midi === midi) best = Math.max(best, notes[index].velocity)
      }
      return best
    }
    const plan = playablePitches(pitches, velocityOf)
    const keepSet = new Set(plan.keep)

    for (const index of sounding) {
      if (!keepSet.has(notes[index].midi)) {
        dropped.add(index)
        continue
      }
      const hand: Hand = notes[index].midi < plan.split ? 'left' : 'right'
      notes[index].hand = hand
      notes[index].color = colorFor(hand, notes[index].midi)
    }
  }

  // Re-assign hands from each note's own simultaneous peers (not the whole cluster).
  for (const index of indices) {
    if (dropped.has(index)) continue
    const note = notes[index]
    const peers = indices.filter((other) => {
      if (dropped.has(other)) return false
      return notes[other].start < note.end && notes[other].end > note.start
    })
    const pitches = [...new Set(peers.map((other) => notes[other].midi))]
    const velocityOf = (midi: number) => {
      let best = 0
      for (const other of peers) {
        if (notes[other].midi === midi) best = Math.max(best, notes[other].velocity)
      }
      return best
    }
    const plan = playablePitches(pitches, velocityOf)
    if (!plan.keep.includes(note.midi)) {
      dropped.add(index)
      continue
    }
    const hand: Hand = note.midi < plan.split ? 'left' : 'right'
    note.hand = hand
    note.color = colorFor(hand, note.midi)
  }

  for (const index of dropped) {
    notes[index].end = notes[index].start
  }
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

  const notes: NoteEvent[] = cleaned.map((note) => ({
    midi: note.midi,
    start: note.start,
    end: note.end,
    velocity: Math.max(0.2, Math.min(1, note.velocity || 0.7)),
    hand: 'right' as Hand,
    color: colorFor('right', note.midi),
    hit: false,
  }))

  for (const cluster of overlapClusters(notes)) {
    enforceClusterPlayable(notes, cluster)
  }

  return notes.filter((note) => note.end - note.start > 0.045)
}

export function rgba(color: [number, number, number], alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`
}
