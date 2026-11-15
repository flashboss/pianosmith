import { t } from './i18n'
import {
  getSyncDirectoryHandle,
  listAllFolders,
  listAllLibrarySongs,
  putLibrarySong,
  setSyncDirectoryHandle,
  upsertFolder,
  type LibraryFolder,
  type LibrarySong,
} from './library'
import type { RawNote } from './types'

const MANIFEST_NAME = 'pianosmith-library.json'
const MEDIA_DIR = 'media'
const AUTO_KEY = 'pianosmith.sync.auto'
const NAME_KEY = 'pianosmith.sync.folderName'
const LAST_KEY = 'pianosmith.sync.lastAt'

type SyncSongEntry = {
  id: string
  title: string
  kind: 'audio' | 'midi'
  source: string
  mime: string
  bytes: number
  duration: number
  folderId: string
  createdAt: number
  updatedAt: number
  media: string
  notes: string
}

type SyncManifest = {
  version: 1
  updatedAt: number
  folders: LibraryFolder[]
  songs: SyncSongEntry[]
}

export type SyncResult = {
  pulled: number
  pushed: number
  folderName: string
}

/** Portable library package used by folder sync and the device bridge. */
export type LibraryBundle = {
  version: 1
  updatedAt: number
  folders: LibraryFolder[]
  songs: Array<{
    id: string
    title: string
    kind: 'audio' | 'midi'
    source: string
    mime: string
    bytes: number
    duration: number
    folderId: string
    createdAt: number
    updatedAt: number
    media: string
    notes: string
  }>
}

export type LibraryBundleSongFiles = {
  mediaName: string
  notesName: string
  data: ArrayBuffer
  notesJson: string
}

export type SyncStatus = {
  supported: boolean
  folderName: string
  linked: boolean
  auto: boolean
  lastAt: number | null
}

function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

function extensionFor(mime: string, kind: 'audio' | 'midi'): string {
  const type = mime.toLowerCase()
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('wav')) return 'wav'
  if (type.includes('flac')) return 'flac'
  if (type.includes('ogg') || type.includes('opus')) return 'ogg'
  if (type.includes('webm')) return 'webm'
  if (type.includes('aac') || type.includes('m4a') || type.includes('mp4')) return 'm4a'
  if (type.includes('aiff') || type.includes('aif')) return 'aiff'
  if (type.includes('midi') || type.includes('mid') || kind === 'midi') return 'mid'
  return 'bin'
}

function safeFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || `song-${Date.now()}`
}

async function ensurePermission(handle: FileSystemDirectoryHandle, mode: 'read' | 'readwrite'): Promise<void> {
  const withPermission = handle as FileSystemDirectoryHandle & {
    queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  }
  if (withPermission.queryPermission) {
    const current = await withPermission.queryPermission({ mode })
    if (current === 'granted') return
  }
  if (withPermission.requestPermission) {
    const next = await withPermission.requestPermission({ mode })
    if (next === 'granted') return
  }
  throw new Error(t('syncPermissionDenied'))
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: BufferSource | Blob | string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  try {
    await writable.write(data)
  } finally {
    await writable.close()
  }
}

async function readTextFile(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const file = await dir.getFileHandle(name)
    return await (await file.getFile()).text()
  } catch {
    return null
  }
}

async function readBinaryFile(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
  try {
    const file = await dir.getFileHandle(name)
    return await (await file.getFile()).arrayBuffer()
  } catch {
    return null
  }
}

function parseManifest(raw: string | null): SyncManifest {
  if (!raw) {
    return { version: 1, updatedAt: 0, folders: [], songs: [] }
  }
  try {
    const parsed = JSON.parse(raw) as SyncManifest
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.folders) || !Array.isArray(parsed.songs)) {
      return { version: 1, updatedAt: 0, folders: [], songs: [] }
    }
    return parsed
  } catch {
    return { version: 1, updatedAt: 0, folders: [], songs: [] }
  }
}

function parseNotes(raw: string | null): RawNote[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as RawNote[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((note) => note && Number.isFinite(note.midi) && Number.isFinite(note.start) && Number.isFinite(note.end))
      .map((note) => ({
        midi: note.midi,
        start: note.start,
        end: note.end,
        velocity: Number.isFinite(note.velocity) ? note.velocity : 0.8,
      }))
  } catch {
    return []
  }
}

function songKey(song: { source: string; id: string }): string {
  return song.source || `id:${song.id}`
}

export function getSyncStatus(): SyncStatus {
  const folderName = (localStorage.getItem(NAME_KEY) || '').trim()
  const lastRaw = localStorage.getItem(LAST_KEY)
  const lastAt = lastRaw ? Number(lastRaw) : NaN
  return {
    supported: canPickDirectory(),
    folderName,
    linked: Boolean(folderName),
    auto: localStorage.getItem(AUTO_KEY) === '1',
    lastAt: Number.isFinite(lastAt) ? lastAt : null,
  }
}

export function setSyncAuto(enabled: boolean): void {
  localStorage.setItem(AUTO_KEY, enabled ? '1' : '0')
}

export function isSyncAutoEnabled(): boolean {
  return localStorage.getItem(AUTO_KEY) === '1'
}

async function linkedDirectory(mode: 'read' | 'readwrite'): Promise<FileSystemDirectoryHandle> {
  const handle = await getSyncDirectoryHandle()
  if (!handle) throw new Error(t('syncFolderNone'))
  await ensurePermission(handle, mode)
  return handle
}

export async function chooseSyncFolder(): Promise<SyncStatus> {
  if (!canPickDirectory()) throw new Error(t('syncUnsupported'))
  const handle = await window.showDirectoryPicker!({ id: 'pianosmith-library', mode: 'readwrite' })
  await ensurePermission(handle, 'readwrite')
  await setSyncDirectoryHandle(handle)
  localStorage.setItem(NAME_KEY, handle.name || t('syncFolder'))
  return getSyncStatus()
}

export async function disconnectSyncFolder(): Promise<SyncStatus> {
  await setSyncDirectoryHandle(null)
  localStorage.removeItem(NAME_KEY)
  localStorage.removeItem(LAST_KEY)
  return getSyncStatus()
}

export async function restoreSyncLink(): Promise<SyncStatus> {
  const status = getSyncStatus()
  if (!status.supported) return status
  try {
    const handle = await getSyncDirectoryHandle()
    if (!handle) {
      if (status.folderName) localStorage.removeItem(NAME_KEY)
      return getSyncStatus()
    }
    localStorage.setItem(NAME_KEY, handle.name || status.folderName || t('syncFolder'))
  } catch {
    // Keep cached name; permission is requested on sync.
  }
  return getSyncStatus()
}

export async function buildLibraryBundle(): Promise<{
  manifest: LibraryBundle
  files: LibraryBundleSongFiles[]
}> {
  const folders = await listAllFolders()
  const songs = await listAllLibrarySongs()
  const files: LibraryBundleSongFiles[] = []
  const manifestSongs: LibraryBundle['songs'] = []

  for (const song of songs) {
    const fileId = safeFileId(song.id)
    const ext = extensionFor(song.mime, song.kind)
    const mediaName = `${fileId}.${ext}`
    const notesName = `${fileId}.notes.json`
    files.push({
      mediaName,
      notesName,
      data: song.data,
      notesJson: JSON.stringify(song.notes),
    })
    manifestSongs.push({
      id: song.id,
      title: song.title,
      kind: song.kind,
      source: song.source,
      mime: song.mime,
      bytes: song.bytes,
      duration: song.duration,
      folderId: song.folderId || '',
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
      media: mediaName,
      notes: notesName,
    })
  }

  return {
    manifest: {
      version: 1,
      updatedAt: Date.now(),
      folders,
      songs: manifestSongs.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
    },
    files,
  }
}

export async function importLibraryBundle(
  manifest: LibraryBundle,
  readFileBytes: (name: string) => Promise<ArrayBuffer | null>,
  readNotes: (name: string) => Promise<string | null>,
): Promise<{ pulled: number }> {
  const localFolders = await listAllFolders()
  const localSongs = await listAllLibrarySongs()
  const foldersById = new Map<string, LibraryFolder>()
  for (const folder of [...(manifest.folders || []), ...localFolders]) {
    const prev = foldersById.get(folder.id)
    if (!prev || folder.updatedAt >= prev.updatedAt) foldersById.set(folder.id, folder)
  }

  for (const folder of foldersById.values()) {
    const local = localFolders.find((row) => row.id === folder.id)
    if (!local || folder.updatedAt > local.updatedAt) await upsertFolder(folder)
  }

  let pulled = 0
  const localByKey = new Map(localSongs.map((song) => [songKey(song), song]))
  for (const entry of manifest.songs || []) {
    const key = songKey(entry)
    const local = localByKey.get(key)
    if (local && local.updatedAt >= entry.updatedAt) continue
    const mediaName = entry.media?.split('/').pop() || entry.media
    const notesName = entry.notes?.split('/').pop() || entry.notes
    if (!mediaName || !notesName) continue
    const data = await readFileBytes(mediaName)
    if (!data) continue
    const notes = parseNotes(await readNotes(notesName))
    const imported: LibrarySong = {
      id: local?.id || entry.id,
      title: entry.title,
      kind: entry.kind,
      source: entry.source,
      mime: entry.mime,
      bytes: data.byteLength,
      duration: entry.duration,
      folderId: entry.folderId || '',
      createdAt: entry.createdAt || entry.updatedAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
      data,
      notes,
    }
    await putLibrarySong(imported)
    pulled += 1
  }
  return { pulled }
}

export async function syncLibrary(): Promise<SyncResult> {
  const dir = await linkedDirectory('readwrite')
  const media = await dir.getDirectoryHandle(MEDIA_DIR, { create: true })
  const remote = parseManifest(await readTextFile(dir, MANIFEST_NAME))

  const localFolders = await listAllFolders()
  const localSongs = await listAllLibrarySongs()
  const foldersById = new Map<string, LibraryFolder>()
  for (const folder of [...remote.folders, ...localFolders]) {
    const prev = foldersById.get(folder.id)
    if (!prev || folder.updatedAt >= prev.updatedAt) foldersById.set(folder.id, folder)
  }

  let pulled = 0
  const localByKey = new Map(localSongs.map((song) => [songKey(song), song]))
  const mergedSongs = new Map<string, LibrarySong>()

  for (const song of localSongs) mergedSongs.set(songKey(song), song)

  for (const entry of remote.songs) {
    const key = songKey(entry)
    const local = localByKey.get(key)
    if (local && local.updatedAt >= entry.updatedAt) continue
    const mediaName = entry.media?.split('/').pop() || entry.media
    const notesName = entry.notes?.split('/').pop() || entry.notes
    if (!mediaName || !notesName) continue
    const data = await readBinaryFile(media, mediaName)
    if (!data) continue
    const notes = parseNotes(await readTextFile(media, notesName))
    const imported: LibrarySong = {
      id: local?.id || entry.id,
      title: entry.title,
      kind: entry.kind,
      source: entry.source,
      mime: entry.mime,
      bytes: data.byteLength,
      duration: entry.duration,
      folderId: entry.folderId || '',
      createdAt: entry.createdAt || entry.updatedAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
      data,
      notes,
    }
    await putLibrarySong(imported)
    if (imported.folderId) {
      const folder = foldersById.get(imported.folderId)
      if (folder) await upsertFolder(folder)
    }
    mergedSongs.set(key, imported)
    pulled += 1
  }

  for (const folder of foldersById.values()) {
    const local = localFolders.find((row) => row.id === folder.id)
    if (!local || folder.updatedAt > local.updatedAt) await upsertFolder(folder)
  }

  const finalSongs = [...mergedSongs.values()]
  let pushed = 0
  const remoteByKey = new Map(remote.songs.map((song) => [songKey(song), song]))
  const manifestSongs: SyncSongEntry[] = []

  for (const song of finalSongs) {
    const fileId = safeFileId(song.id)
    const ext = extensionFor(song.mime, song.kind)
    const mediaName = `${fileId}.${ext}`
    const notesName = `${fileId}.notes.json`
    const remoteEntry = remoteByKey.get(songKey(song))
    const needsWrite = !remoteEntry || song.updatedAt > remoteEntry.updatedAt || remoteEntry.media !== mediaName
    if (needsWrite) {
      await writeFile(media, mediaName, song.data)
      await writeFile(media, notesName, JSON.stringify(song.notes))
      pushed += 1
    }
    manifestSongs.push({
      id: song.id,
      title: song.title,
      kind: song.kind,
      source: song.source,
      mime: song.mime,
      bytes: song.bytes,
      duration: song.duration,
      folderId: song.folderId || '',
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
      media: `${MEDIA_DIR}/${mediaName}`,
      notes: `${MEDIA_DIR}/${notesName}`,
    })
  }

  const manifest: SyncManifest = {
    version: 1,
    updatedAt: Date.now(),
    folders: [...foldersById.values()].sort((a, b) => a.name.localeCompare(b.name)),
    songs: manifestSongs.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
  }
  await writeFile(dir, MANIFEST_NAME, JSON.stringify(manifest, null, 2))

  const folderName = dir.name || localStorage.getItem(NAME_KEY) || t('syncFolder')
  localStorage.setItem(NAME_KEY, folderName)
  localStorage.setItem(LAST_KEY, String(manifest.updatedAt))

  return { pulled, pushed, folderName }
}
