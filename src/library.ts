import type { RawNote } from './types'

const DB_NAME = 'pianosmith'
const DB_VERSION = 1
const STORE = 'songs'
const MAX_SONGS = 40
const MAX_BYTES = 220 * 1024 * 1024

export type LibraryKind = 'audio' | 'midi'

export interface LibrarySongMeta {
  id: string
  title: string
  kind: LibraryKind
  source: string
  mime: string
  bytes: number
  duration: number
  createdAt: number
  updatedAt: number
}

export interface LibrarySong extends LibrarySongMeta {
  data: ArrayBuffer
  notes: RawNote[]
}

export type LibrarySongInput = {
  title: string
  kind: LibraryKind
  source: string
  mime: string
  data: ArrayBuffer
  notes: RawNote[]
  duration: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
        store.createIndex('source', 'source', { unique: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB non disponibile'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Operazione IndexedDB non riuscita'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('Transazione IndexedDB non riuscita'))
    tx.onabort = () => reject(tx.error || new Error('Transazione IndexedDB interrotta'))
  })
}

function sourceKey(source: string): string {
  return source.trim().slice(0, 500) || `local:${Date.now()}`
}

function songId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `song-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function toMeta(song: LibrarySong): LibrarySongMeta {
  return {
    id: song.id,
    title: song.title,
    kind: song.kind,
    source: song.source,
    mime: song.mime,
    bytes: song.bytes,
    duration: song.duration,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  }
}

export async function listLibrarySongs(): Promise<LibrarySongMeta[]> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const rows = (await requestToPromise(store.getAll())) as LibrarySong[]
    await txDone(tx)
    return rows
      .map(toMeta)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } finally {
    db.close()
  }
}

export async function getLibrarySong(id: string): Promise<LibrarySong | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const row = (await requestToPromise(store.get(id))) as LibrarySong | undefined
    await txDone(tx)
    return row || null
  } finally {
    db.close()
  }
}

async function findBySource(store: IDBObjectStore, source: string): Promise<LibrarySong | null> {
  const index = store.index('source')
  const row = (await requestToPromise(index.get(source))) as LibrarySong | undefined
  return row || null
}

async function allSongs(store: IDBObjectStore): Promise<LibrarySong[]> {
  return (await requestToPromise(store.getAll())) as LibrarySong[]
}

async function prune(store: IDBObjectStore, keepId: string): Promise<void> {
  const rows = (await allSongs(store)).sort((a, b) => a.updatedAt - b.updatedAt)
  let total = rows.reduce((sum, row) => sum + (row.bytes || 0), 0)
  while (rows.length > MAX_SONGS || total > MAX_BYTES) {
    const oldest = rows.find((row) => row.id !== keepId) || rows[0]
    if (!oldest) break
    total -= oldest.bytes || 0
    rows.splice(rows.indexOf(oldest), 1)
    store.delete(oldest.id)
  }
}

export async function saveLibrarySong(input: LibrarySongInput): Promise<LibrarySongMeta> {
  const source = sourceKey(input.source)
  const now = Date.now()
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const existing = await findBySource(store, source)
    const song: LibrarySong = {
      id: existing?.id || songId(),
      title: input.title.slice(0, 180) || 'Audio',
      kind: input.kind,
      source,
      mime: input.mime || 'application/octet-stream',
      bytes: input.data.byteLength,
      duration: input.duration || 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      data: input.data,
      notes: input.notes.map((note) => ({
        midi: note.midi,
        start: note.start,
        end: note.end,
        velocity: note.velocity,
      })),
    }
    store.put(song)
    await prune(store, song.id)
    await txDone(tx)
    return toMeta(song)
  } finally {
    db.close()
  }
}

export async function removeLibrarySong(id: string): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await txDone(tx)
  } finally {
    db.close()
  }
}

export function fileSourceKey(file: File): string {
  return `file:${file.name}:${file.size}:${file.lastModified}`
}

export function linkSourceKey(url: string): string {
  return `link:${url.trim()}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}
