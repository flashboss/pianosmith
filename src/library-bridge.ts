import { serverBase } from './api'
import { t } from './i18n'
import {
  buildLibraryBundle,
  importLibraryBundle,
  type LibraryBundle,
} from './library-sync'

const LISTEN_ROOM_KEY = 'pianosmith.libraryBridge.room'

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

export type LibraryRoomStatus = {
  room: string
  ready: boolean
  bytes: number
  songs: number
  listeners: number
}

/** Display listens; another device uploads its library into the room. */
export class LibraryBridge {
  private source: EventSource | null = null
  private room = ''
  private handlers: LibraryBridgeHandlers = {}
  private wantListen = false
  private reconnectTimer = 0
  private pollTimer = 0
  private lastReadyKey = ''
  private pendingReadyKey = ''
  private lastPingAt = 0
  listening = false

  setHandlers(handlers: LibraryBridgeHandlers) {
    this.handlers = handlers
  }

  get code() {
    return this.room
  }

  /** Last room this display was listening to (survives reload on TV). */
  static savedListenRoom(): string {
    try {
      return cleanCode(localStorage.getItem(LISTEN_ROOM_KEY) || '')
    } catch {
      return ''
    }
  }

  private persistListenRoom(code: string) {
    try {
      if (code) localStorage.setItem(LISTEN_ROOM_KEY, code)
      else localStorage.removeItem(LISTEN_ROOM_KEY)
    } catch {
      /* ignore */
    }
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
    this.stopPoll()
    this.stopStream(true)
    this.room = cleanCode(room)
    if (this.room.length < 4) return
    this.wantListen = true
    this.persistListenRoom(this.room)
    this.openStream()
    this.startPoll()
  }

  private openStream() {
    if (!this.wantListen || !this.room) return
    this.stopStream(false)
    const source = new EventSource(`${base()}/api/library/${encodeURIComponent(this.room)}/stream`)
    this.source = source
    this.listening = true
    this.lastPingAt = Date.now()
    this.handlers.onStatus?.('listen')
    source.addEventListener('hello', (event) => {
      this.lastPingAt = Date.now()
      this.handlers.onStatus?.('ready')
      try {
        const data = JSON.parse((event as MessageEvent).data) as { ready?: boolean }
        if (data.ready) void this.pollReady()
      } catch {
        /* ignore */
      }
    })
    source.addEventListener('ping', () => {
      this.lastPingAt = Date.now()
      if (this.listening) this.handlers.onStatus?.('ready')
    })
    source.addEventListener('ready', () => {
      void this.pollReady()
    })
    source.onerror = () => {
      this.handlers.onStatus?.('error')
      this.scheduleReconnect()
    }
  }

  private emitReady(statusKey: string) {
    if (!this.room) return
    if (statusKey === this.lastReadyKey || statusKey === this.pendingReadyKey) return
    this.pendingReadyKey = statusKey
    this.handlers.onStatus?.('package')
    this.handlers.onReady?.(this.room)
  }

  private scheduleReconnect() {
    if (!this.wantListen || this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0
      if (!this.wantListen) return
      this.openStream()
    }, 2000)
  }

  private startPoll() {
    this.stopPoll()
    if (!this.wantListen || !this.room) return
    const beat = () => {
      void this.pollReady()
      // Tizen often leaves EventSource stuck; force reconnect if quiet.
      if (this.wantListen && this.lastPingAt && Date.now() - this.lastPingAt > 35_000) {
        this.scheduleReconnect()
      }
    }
    beat()
    this.pollTimer = window.setInterval(beat, 8_000)
  }

  private stopPoll() {
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = 0
    }
  }

  async fetchStatus(room = this.room): Promise<LibraryRoomStatus | null> {
    const code = cleanCode(room)
    if (code.length < 4) return null
    try {
      const response = await fetch(`${base()}/api/library/${encodeURIComponent(code)}/status`)
      if (!response.ok) return null
      return (await response.json()) as LibraryRoomStatus
    } catch {
      return null
    }
  }

  /** Poll room status; fire onReady when a new package is available. */
  async pollReady(room = this.room): Promise<boolean> {
    const status = await this.fetchStatus(room)
    if (!status?.ready) return false
    this.lastPingAt = Date.now()
    const key = `${status.room}:${status.bytes}:${status.songs}`
    if (key === this.lastReadyKey || key === this.pendingReadyKey) return false
    this.emitReady(key)
    return true
  }

  /** Call after a successful pull so the next identical package is not re-imported. */
  markPulled(status?: { bytes?: number; songs?: number } | null) {
    if (!this.room) return
    const bytes = status?.bytes ?? 0
    const songs = status?.songs ?? 0
    this.lastReadyKey = `${this.room}:${bytes}:${songs}`
    this.pendingReadyKey = ''
  }

  /** Clear pending key so a failed pull can retry on the next poll. */
  clearPendingPull() {
    this.pendingReadyKey = ''
  }

  private stopStream(clearWant: boolean) {
    if (clearWant) this.wantListen = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = 0
    }
    this.source?.close()
    this.source = null
    this.listening = false
  }

  stop() {
    this.stopPoll()
    this.stopStream(true)
    this.persistListenRoom('')
    this.lastReadyKey = ''
    this.pendingReadyKey = ''
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

    const result = await importLibraryBundle(
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
    const status = await this.fetchStatus(code)
    this.markPulled(status ?? { bytes: 0, songs: manifest.songs.length })
    return result
  }
}
