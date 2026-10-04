import { Midi } from '@tonejs/midi'
import type { NoteEvent, RawNote } from './types'

export function isMidiFile(file: File): boolean {
  return /\.mid$|\.midi$/i.test(file.name) || file.type === 'audio/midi' || file.type === 'audio/mid'
}

export function notesFromMidi(data: ArrayBuffer): { notes: RawNote[]; title: string } {
  const midi = new Midi(data)
  const notes: RawNote[] = []
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.push({
        midi: note.midi,
        start: note.time,
        end: note.time + note.duration,
        velocity: note.velocity,
      })
    }
  }
  const title = midi.name || midi.header.name || 'MIDI'
  return { notes, title }
}

export function songToMidiBlob(notes: NoteEvent[], title: string): Blob {
  const midi = new Midi()
  midi.name = title
  const track = midi.addTrack()
  track.name = 'Piano'
  for (const note of notes) {
    track.addNote({
      midi: note.midi,
      time: note.start,
      duration: Math.max(0.05, note.end - note.start),
      velocity: note.velocity,
    })
  }
  const data = midi.toArray()
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return new Blob([copy], { type: 'audio/midi' })
}
