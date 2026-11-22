import type { NoteEvent } from './types'

export type TimeSignature = {
  /** Top number (beats / pulse groups per bar). */
  numerator: number
  /** Bottom number (note value that gets the beat): 2, 4, or 8. */
  denominator: number
  /** Bar length in quarter-note units at the estimated BPM. */
  quartersPerBar: number
}

const CANDIDATES: TimeSignature[] = [
  { numerator: 2, denominator: 4, quartersPerBar: 2 },
  { numerator: 3, denominator: 4, quartersPerBar: 3 },
  { numerator: 4, denominator: 4, quartersPerBar: 4 },
  { numerator: 2, denominator: 2, quartersPerBar: 4 },
  { numerator: 3, denominator: 8, quartersPerBar: 1.5 },
  { numerator: 6, denominator: 8, quartersPerBar: 3 },
]

/** Estimate tempo from note onset gaps (same heuristic as the PDF sheet). */
export function estimateBpm(notes: NoteEvent[]): number {
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

/** Italian tempo word for a metronome marking. */
export function tempoLabel(bpm: number): string {
  if (bpm < 60) return 'Largo'
  if (bpm < 76) return 'Adagio'
  if (bpm < 108) return 'Andante'
  if (bpm < 120) return 'Moderato'
  if (bpm < 168) return 'Allegro'
  return 'Presto'
}

export function formatTimeSignature(ts: TimeSignature): string {
  return `${ts.numerator}/${ts.denominator}`
}

/** Seconds per bar for the estimated BPM and meter. */
export function measureSeconds(bpm: number, ts: TimeSignature): number {
  return (60 / Math.max(1, bpm)) * ts.quartersPerBar
}

type WeightedOnset = { t: number; w: number }

function weightedOnsets(notes: NoteEvent[]): WeightedOnset[] {
  const byTime = new Map<number, number>()
  for (const note of notes) {
    const t = Math.round(note.start * 1000) / 1000
    const dur = Math.max(0.04, note.end - note.start)
    const w = dur * (0.45 + (note.velocity || 80) / 180)
    byTime.set(t, (byTime.get(t) ?? 0) + w)
  }
  return [...byTime.entries()]
    .map(([t, w]) => ({ t, w }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Score how well a bar length fits onsets: strong weight on downbeats,
 * medium on half-bar (compound / binary), light on other beat pulses.
 */
function scoreMeter(
  onsets: WeightedOnset[],
  beatSec: number,
  ts: TimeSignature,
  t0: number,
  t1: number,
): number {
  const measureSec = beatSec * ts.quartersPerBar
  if (measureSec < 0.45 || measureSec > 6.5) return -Infinity

  const phaseSteps = 12
  let best = -Infinity
  for (let p = 0; p < phaseSteps; p++) {
    const phase = (p / phaseSteps) * measureSec
    let score = 0
    let weight = 0
    for (const { t, w } of onsets) {
      if (t < t0 - 0.05 || t > t1 + 0.05) continue
      const pos = ((t - t0 - phase) % measureSec + measureSec) % measureSec
      const frac = pos / measureSec
      // Downbeat
      const distBar = Math.min(frac, 1 - frac)
      const barWin = 0.07
      if (distBar < barWin) score += w * (1 - distBar / barWin) * 1.35

      // Half-bar (2/4 mid, 4/4 beat 3, 6/8 secondary dotted-quarter)
      const distHalf = Math.abs(frac - 0.5)
      if (distHalf < barWin) score += w * (1 - distHalf / barWin) * 0.55

      // Remaining simple-meter beats (quarter grid)
      if (ts.denominator === 4 || ts.denominator === 2) {
        const beats = ts.numerator
        for (let b = 1; b < beats; b++) {
          if (b * 2 === beats) continue // already counted as half
          const target = b / beats
          const d = Math.abs(frac - target)
          if (d < barWin) score += w * (1 - d / barWin) * 0.28
        }
      } else if (ts.numerator === 6 && ts.denominator === 8) {
        // Tertiary eighth pulses inside each dotted-quarter group
        for (const target of [1 / 6, 2 / 6, 4 / 6, 5 / 6]) {
          const d = Math.abs(frac - target)
          if (d < barWin) score += w * (1 - d / barWin) * 0.18
        }
      }

      weight += w
    }
    if (weight < 0.01) continue
    // Prefer denser alignment; mild prior toward common meters.
    const prior =
      ts.numerator === 4 && ts.denominator === 4
        ? 0.04
        : ts.numerator === 3 && ts.denominator === 4
          ? 0.025
          : ts.numerator === 6 && ts.denominator === 8
            ? 0.02
            : 0
    const normalized = score / weight + prior
    if (normalized > best) best = normalized
  }
  return best
}

/**
 * Detect time signature from onset accents against candidate meters at the
 * estimated BPM. Falls back to 4/4 when evidence is weak.
 */
export function detectTimeSignature(notes: NoteEvent[], bpm = estimateBpm(notes)): TimeSignature {
  const onsets = weightedOnsets(notes)
  if (onsets.length < 4) return { numerator: 4, denominator: 4, quartersPerBar: 4 }

  const t0 = onsets[0].t
  const t1 = onsets[onsets.length - 1].t
  if (t1 - t0 < 2.5) return { numerator: 4, denominator: 4, quartersPerBar: 4 }

  const beatSec = 60 / Math.max(1, bpm)
  let best = CANDIDATES[2] // 4/4
  let bestScore = -Infinity
  for (const candidate of CANDIDATES) {
    const score = scoreMeter(onsets, beatSec, candidate, t0, t1)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** Sixteenth-note ticks in one bar (PDF / VexFlow grid uses quarter÷4). */
export function measureSixteenthTicks(ts: TimeSignature): number {
  return Math.max(1, Math.round(ts.quartersPerBar * 4))
}
