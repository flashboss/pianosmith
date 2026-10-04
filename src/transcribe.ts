import type { RawNote } from './types'

let modelPromise: Promise<import('@spotify/basic-pitch').BasicPitch> | null = null

async function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await import('@tensorflow/tfjs')
      try {
        await tf.setBackend('webgl')
      } catch {
        await tf.setBackend('cpu')
      }
      await tf.ready()
      const { BasicPitch } = await import('@spotify/basic-pitch')
      const url = new URL(`${import.meta.env.BASE_URL}model/model.json`, window.location.href).toString()
      return new BasicPitch(url)
    })()
  }
  return modelPromise
}

async function toModelBuffer(buffer: AudioBuffer): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(buffer.duration * 22050))
  const offline = new OfflineAudioContext(1, length, 22050)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start(0)
  return offline.startRendering()
}

export async function transcribeAudio(
  buffer: AudioBuffer,
  onProgress: (label: string, ratio: number | null) => void,
): Promise<RawNote[]> {
  onProgress('Carico il modello di trascrizione…', null)
  const basicPitch = await loadModel()
  onProgress('Preparo l’audio…', 0.02)
  const mono = await toModelBuffer(buffer)
  const { noteFramesToTime, outputToNotesPoly } = await import('@spotify/basic-pitch')

  const frames: number[][] = []
  const onsets: number[][] = []

  await basicPitch.evaluateModel(
    mono,
    (frameChunk, onsetChunk) => {
      frames.push(...frameChunk)
      onsets.push(...onsetChunk)
    },
    (percent) => {
      onProgress('Trascrivo le note…', percent)
    },
  )

  onProgress('Ricostruisco la partitura…', 1)
  if (frames.length === 0) return []

  const events = outputToNotesPoly(frames, onsets, 0.34, 0.28, 5)
  const timed = noteFramesToTime(events)
  const notes: RawNote[] = []
  for (const event of timed) {
    let start = event.startTimeSeconds
    let duration = event.durationSeconds
    if (start < 0) {
      duration += start
      start = 0
    }
    if (duration < 0.045) continue
    if (event.pitchMidi < 21 || event.pitchMidi > 108) continue
    notes.push({
      midi: event.pitchMidi,
      start,
      end: start + duration,
      velocity: Math.max(0.2, Math.min(1, event.amplitude || 0.7)),
    })
  }
  return notes
}
