import { serverBase } from './api'
import { t } from './i18n'
import {
  buildLibraryBundle,
  importLibraryBundle,
  type LibraryBundle,
} from './library-sync'

function base(): string {
  return serverBase().replace(/\/$/, '')
}

function cleanCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) return body.message
  } catch {
    /* ignore */
  }
  return t('syncBridgeFail')
}

export type LibraryBridgeHandlers = {
  onStatus?: (text: string) => void
  onReady?: (code: string) => void
}

/** Display listens; another device uploads its library into the room. */
export class LibraryBridge {
  private source: EventSource | null = null
  private room = ''
  private handlers: LibraryBridgeHandlers = {}
  listening = false

  setHandlers(handlers: LibraryBridgeHandlers) {
    this.handlers = handlers
  }

  get code() {
    return this.room
  }

  async createRoom(): Promise<string> {
    const response = await fetch(`${base()}/api/library/room`, { method: 'POST' })
    if (!response.ok) throw new Error(await readError(response))
    const body = (await response.json()) as { code?: string }
    if (!body.code) throw new Error(t('syncBridgeFail'))
    this.room = body.code
    return this.room
  }

  listen(room: string) {
    this.stop()
    this.room = cleanCode(room)
    if (this.room.length < 4) return
    const source = new EventSource(`${base()}/api/library/${encodeURIComponent(this.room)}/stream`)
    this.source = source
    this.listening = true
    this.handlers.onStatus?.('listen')
    source.addEventListener('hello', () => this.handlers.onStatus?.('ready'))
    source.addEventListener('ready', () => {
      this.handlers.onStatus?.('package')
      this.handlers.onReady?.(this.room)
    })
    source.onerror = () => this.handlers.onStatus?.('error')
  }

  stop() {
    this.source?.close()
    this.source = null
    this.listening = false
  }

  async pushLibrary(room = this.room): Promise<{ songs: number }> {
    const code = cleanCode(room)
    if (code.length < 4) throw new Error(t('syncBridgeCodeInvalid'))
    this.room = code
    const { manifest, files } = await buildLibraryBundle()

    const manifestResponse = await fetch(`${base()}/api/library/${encodeURIComponent(code)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    })
    if (!manifestResponse.ok) throw new Error(await readError(manifestResponse))

    for (const file of files) {
      const mediaResponse = await fetch(
        `${base()}/api/library/${encodeURIComponent(code)}/file/${encodeURIComponent(file.mediaName)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.data,
        },
      )
      if (!mediaResponse.ok) throw new Error(await readError(mediaResponse))

      const notesResponse = await fetch(
        `${base()}/api/library/${encodeURIComponent(code)}/file/${encodeURIComponent(file.notesName)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: file.notesJson,
        },
      )
      if (!notesResponse.ok) throw new Error(await readError(notesResponse))
    }

    const readyResponse = await fetch(`${base()}/api/library/${encodeURIComponent(code)}/ready`, {
      method: 'POST',
    })
    if (!readyResponse.ok) throw new Error(await readError(readyResponse))
    return { songs: manifest.songs.length }
  }

  async pullLibrary(room = this.room): Promise<{ pulled: number }> {
    const code = cleanCode(room)
    if (code.length < 4) throw new Error(t('syncBridgeCodeInvalid'))
    this.room = code

    const manifestResponse = await fetch(`${base()}/api/library/${encodeURIComponent(code)}/manifest`)
    if (!manifestResponse.ok) throw new Error(await readError(manifestResponse))
    const manifest = (await manifestResponse.json()) as LibraryBundle
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.songs)) {
      throw new Error(t('syncBridgeFail'))
    }

    return importLibraryBundle(
      manifest,
      async (name) => {
        const response = await fetch(
          `${base()}/api/library/${encodeURIComponent(code)}/file/${encodeURIComponent(name)}`,
        )
        if (!response.ok) return null
        return response.arrayBuffer()
      },
      async (name) => {
        const response = await fetch(
          `${base()}/api/library/${encodeURIComponent(code)}/file/${encodeURIComponent(name)}`,
        )
        if (!response.ok) return null
        return response.text()
      },
    )
  }
}
