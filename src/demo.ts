import type { RawNote } from './types'

const BEAT = 0.5

function add(out: RawNote[], midi: number, beat: number, dur: number, velocity = 0.8) {
  out.push({
    midi,
    start: beat * BEAT,
    end: (beat + dur) * BEAT,
    velocity,
  })
}

/** Original short piece used as the offline demo. */
export function demoNotes(): RawNote[] {
  const out: RawNote[] = []
  const progression = [
    [45, 48, 52, 57],
    [41, 48, 53, 57],
    [43, 47, 50, 55],
    [40, 47, 52, 55],
    [45, 48, 52, 57],
    [41, 48, 53, 57],
    [43, 47, 50, 55],
    [40, 47, 52, 56],
  ]

  for (let bar = 0; bar < progression.length; bar++) {
    const chord = progression[bar]
    const t = bar * 4
    add(out, chord[0], t, 3.7, 0.72)
    const roll = [chord[1], chord[2], chord[3], chord[2]]
    for (let i = 0; i < 8; i++) {
      add(out, roll[i % 4], t + i * 0.5, 0.7, 0.46 + (i % 2) * 0.08)
    }
  }

  const melody: Array<[number, number, number, number]> = [
    [76, 0, 1.45, 0.92],
    [74, 1.5, 0.4, 0.7],
    [72, 2, 0.95, 0.86],
    [69, 3, 0.9, 0.76],
    [72, 4, 1.25, 0.88],
    [69, 5.3, 0.45, 0.7],
    [65, 6, 1.6, 0.82],
    [64, 8, 0.7, 0.84],
    [67, 8.8, 0.65, 0.8],
    [71, 9.5, 1, 0.9],
    [67, 10.6, 0.35, 0.66],
    [64, 11, 0.9, 0.76],
    [76, 12, 1.7, 0.94],
    [74, 13.8, 0.35, 0.7],
    [72, 14.2, 0.75, 0.82],
    [69, 15, 0.9, 0.78],
    [72, 16, 0.32, 0.72],
    [74, 16.35, 0.32, 0.76],
    [76, 16.7, 0.32, 0.82],
    [79, 17.05, 0.32, 0.88],
    [81, 17.4, 1.15, 0.94],
    [79, 18.65, 0.4, 0.72],
    [76, 19.15, 0.75, 0.84],
    [74, 20, 0.9, 0.78],
    [72, 21, 1.35, 0.86],
    [69, 22.45, 0.4, 0.68],
    [65, 23, 0.9, 0.76],
    [64, 24, 0.45, 0.74],
    [67, 24.5, 0.45, 0.78],
    [71, 25, 0.9, 0.88],
    [74, 26, 0.85, 0.86],
    [76, 27, 0.9, 0.9],
    [79, 28, 1.35, 0.95],
    [76, 29.45, 0.4, 0.72],
    [74, 30, 0.7, 0.8],
    [68, 30.75, 0.35, 0.7],
    [72, 31.15, 0.75, 0.82],
  ]
  for (const [midi, beat, dur, velocity] of melody) add(out, midi, beat, dur, velocity)

  const harmony: Array<[number, number]> = [
    [69, 0],
    [65, 4],
    [67, 8],
    [72, 12],
    [76, 17.4],
    [71, 24],
    [72, 28],
  ]
  for (const [midi, beat] of harmony) add(out, midi, beat, 1.15, 0.4)

  for (const midi of [45, 52, 57, 60, 64, 69, 76]) add(out, midi, 32, 3.4, 0.88)
  return out
}

export const DEMO_TITLE = 'Demo — Notturno'
