export type Hand = 'left' | 'right'

export interface RawNote {
  midi: number
  start: number
  end: number
  velocity: number
}

export interface NoteEvent extends RawNote {
  hand: Hand
  color: [number, number, number]
  hit: boolean
}
