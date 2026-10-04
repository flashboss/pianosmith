import type { Player } from './player'

function supportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

export function canRecord(): boolean {
  return supportedMime() !== null
}

export async function recordSong(
  canvas: HTMLCanvasElement,
  player: Player,
  untilDone: () => Promise<void>,
): Promise<Blob> {
  const mimeType = supportedMime()
  if (!mimeType) throw new Error('Questo browser non può registrare il video')
  await player.resume()
  const stream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], player.audioTrack()])
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 192_000,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    recorder.onerror = () => reject(new Error('Registrazione interrotta'))
  })
  recorder.start(250)
  try {
    await untilDone()
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
  }
  return stopped
}
