import type { RawNote } from './types'

const DB_NAME = 'pianosmith'
const DB_VERSION = 2
const SONGS = 'songs'
const FOLDERS = 'folders'
const MAX_SONGS = 40
const MAX_BYTES = 220 * 1024 * 1024

export const ROOT_FOLDER_ID = ''

export type LibraryKind = 'audio' | 'midi'

export interface LibraryFolder {
  id: string
  name: string
  parentId: string
  createdAt: number
  updatedAt: number
}

export interface LibrarySongMeta {
  id: string
  title: string
  kind: LibraryKind
  source: string
  mime: string
  bytes: number
  duration: number
  folderId: string
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
  folderId?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const tx = request.transaction
      if (!db.objectStoreNames.contains(SONGS)) {
        const store = db.createObjectStore(SONGS, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
        store.createIndex('source', 'source', { unique: true })
        store.createIndex('folderId', 'folderId')
      } else if (tx) {
        const store = tx.objectStore(SONGS)
        if (!store.indexNames.contains('folderId')) store.createIndex('folderId', 'folderId')
      }
      if (!db.objectStoreNames.contains(FOLDERS)) {
        const folders = db.createObjectStore(FOLDERS, { keyPath: 'id' })
        folders.createIndex('parentId', 'parentId')
        folders.createIndex('updatedAt', 'updatedAt')
      }
    }
    request.onsuccess = async () => {
      const db = request.result
      try {
        await migrateSongs(db)
        resolve(db)
      } catch (error) {
        db.close()
        reject(error)
      }
    }
    request.onerror = () => reject(request.error || new Error('IndexedDB non disponibile'))
  })
}

async function migrateSongs(db: IDBDatabase): Promise<void> {
  if (!db.objectStoreNames.contains(SONGS)) return
  const tx = db.transaction(SONGS, 'readwrite')
  const store = tx.objectStore(SONGS)
  const rows = (await requestToPromise(store.getAll())) as Array<LibrarySong & { folderId?: string }>
  for (const row of rows) {
    if (typeof row.folderId === 'string') continue
    row.folderId = ROOT_FOLDER_ID
    store.put(row)
  }
  await txDone(tx)
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

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
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
    folderId: song.folderId || ROOT_FOLDER_ID,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  }
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb()
  try {
    return await fn(db)
  } finally {
    db.close()
  }
}

export async function countLibrarySongs(): Promise<number> {
  return withDb(async (db) => {
    const tx = db.transaction(SONGS, 'readonly')
    const count = await requestToPromise(tx.objectStore(SONGS).count())
    await txDone(tx)
    return count
  })
}

export async function listLibrarySongs(folderId = ROOT_FOLDER_ID): Promise<LibrarySongMeta[]> {
  return withDb(async (db) => {
    const tx = db.transaction(SONGS, 'readonly')
    const store = tx.objectStore(SONGS)
    const rows = (await requestToPromise(store.getAll())) as LibrarySong[]
    await txDone(tx)
    return rows
      .map(toMeta)
      .filter((row) => (row.folderId || ROOT_FOLDER_ID) === folderId)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'it'))
  })
}

export async function listFolders(parentId = ROOT_FOLDER_ID): Promise<LibraryFolder[]> {
  return withDb(async (db) => {
    const tx = db.transaction(FOLDERS, 'readonly')
    const store = tx.objectStore(FOLDERS)
    const rows = (await requestToPromise(store.getAll())) as LibraryFolder[]
    await txDone(tx)
    return rows
      .filter((row) => (row.parentId || ROOT_FOLDER_ID) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'it'))
  })
}

export async function listAllFolders(): Promise<LibraryFolder[]> {
  return withDb(async (db) => {
    const tx = db.transaction(FOLDERS, 'readonly')
    const rows = (await requestToPromise(tx.objectStore(FOLDERS).getAll())) as LibraryFolder[]
    await txDone(tx)
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'it'))
  })
}

export async function getFolder(id: string): Promise<LibraryFolder | null> {
  if (!id) return null
  return withDb(async (db) => {
    const tx = db.transaction(FOLDERS, 'readonly')
    const row = (await requestToPromise(tx.objectStore(FOLDERS).get(id))) as LibraryFolder | undefined
    await txDone(tx)
    return row || null
  })
}

export async function folderPath(folderId: string): Promise<LibraryFolder[]> {
  if (!folderId) return []
  const folders = await listAllFolders()
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: LibraryFolder[] = []
  let current: string | undefined = folderId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder = byId.get(current)
    if (!folder) break
    path.unshift(folder)
    current = folder.parentId || undefined
  }
  return path
}

export async function folderOptions(): Promise<Array<{ id: string; label: string }>> {
  const folders = await listAllFolders()
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const labelFor = (id: string): string => {
    const parts: string[] = []
    let current: string | undefined = id
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const folder = byId.get(current)
      if (!folder) break
      parts.unshift(folder.name)
      current = folder.parentId || undefined
    }
    return parts.join(' / ') || 'Cartella'
  }
  return [
    { id: ROOT_FOLDER_ID, label: 'Brani salvati' },
    ...folders
      .map((folder) => ({ id: folder.id, label: labelFor(folder.id) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'it')),
  ]
}

export async function createFolder(name: string, parentId = ROOT_FOLDER_ID): Promise<LibraryFolder> {
  const cleaned = cleanName(name)
  if (!cleaned) throw new Error('Scrivi un nome per la cartella')
  const siblings = await listFolders(parentId)
  if (siblings.some((folder) => folder.name.toLowerCase() === cleaned.toLowerCase())) {
    throw new Error('Esiste già una cartella con questo nome')
  }
  const now = Date.now()
  const folder: LibraryFolder = {
    id: newId('folder'),
    name: cleaned,
    parentId: parentId || ROOT_FOLDER_ID,
    createdAt: now,
    updatedAt: now,
  }
  await withDb(async (db) => {
    const tx = db.transaction(FOLDERS, 'readwrite')
    tx.objectStore(FOLDERS).put(folder)
    await txDone(tx)
  })
  return folder
}

export async function removeFolder(id: string): Promise<void> {
  if (!id) throw new Error('Cartella non valida')
  const [children, songs] = await Promise.all([listFolders(id), listLibrarySongs(id)])
  if (children.length > 0 || songs.length > 0) {
    throw new Error('Svuota la cartella prima di eliminarla')
  }
  await withDb(async (db) => {
    const tx = db.transaction(FOLDERS, 'readwrite')
    tx.objectStore(FOLDERS).delete(id)
    await txDone(tx)
  })
}

export async function getLibrarySong(id: string): Promise<LibrarySong | null> {
  return withDb(async (db) => {
    const tx = db.transaction(SONGS, 'readonly')
    const row = (await requestToPromise(tx.objectStore(SONGS).get(id))) as LibrarySong | undefined
    await txDone(tx)
    return row || null
  })
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
  return withDb(async (db) => {
    const tx = db.transaction(SONGS, 'readwrite')
    const store = tx.objectStore(SONGS)
    const existing = await findBySource(store, source)
    const song: LibrarySong = {
      id: existing?.id || newId('song'),
      title: input.title.slice(0, 180) || 'Audio',
      kind: input.kind,
      source,
      mime: input.mime || 'application/octet-stream',
      bytes: input.data.byteLength,
      duration: input.duration || 0,
      folderId: existing?.folderId ?? input.folderId ?? ROOT_FOLDER_ID,
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
  })
}

export async function moveLibrarySong(id: string, folderId: string): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction([SONGS, FOLDERS], 'readwrite')
    const songs = tx.objectStore(SONGS)
    const song = (await requestToPromise(songs.get(id))) as LibrarySong | undefined
    if (!song) throw new Error('Brano non trovato nella playlist')
    const target = folderId || ROOT_FOLDER_ID
    if (target) {
      const folder = (await requestToPromise(tx.objectStore(FOLDERS).get(target))) as LibraryFolder | undefined
      if (!folder) throw new Error('Cartella non trovata')
    }
    song.folderId = target
    song.updatedAt = Date.now()
    songs.put(song)
    await txDone(tx)
  })
}

export async function removeLibrarySong(id: string): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(SONGS, 'readwrite')
    tx.objectStore(SONGS).delete(id)
    await txDone(tx)
  })
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
