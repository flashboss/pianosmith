import { strFromU8, unzipSync, zipSync } from 'fflate'
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
const MODE_KEY = 'pianosmith.sync.mode'

/** Session cache — IndexedDB handle persistence is unreliable on some Android Chrome builds. */
let memoryDirectoryHandle: FileSystemDirectoryHandle | null = null

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

export type SyncMode = 'handle' | 'files'

export type SyncStatus = {
  /** Live folder link via File System Access (Chromium). */
  canLinkFolder: boolean
  /** Always true — zip / folder-file sync works in every browser. */
  supported: boolean
  mode: SyncMode
  folderName: string
  linked: boolean
  auto: boolean
  lastAt: number | null
}

export function canPickDirectory(): boolean {
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

async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite',
  options: { allowRequest?: boolean } = {},
): Promise<void> {
  const withPermission = handle as FileSystemDirectoryHandle & {
    queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  }
  if (withPermission.queryPermission) {
    const current = await withPermission.queryPermission({ mode })
    if (current === 'granted') return
    // After showDirectoryPicker the user gesture is often already spent (Android Chrome).
    // Trust the freshly picked handle instead of calling requestPermission.
    if (options.allowRequest === false && current !== 'denied') return
  } else if (options.allowRequest === false) {
    return
  }
  if (options.allowRequest !== false && withPermission.requestPermission) {
    const next = await withPermission.requestPermission({ mode })
    if (next === 'granted') return
  }
  if (withPermission.queryPermission) {
    const current = await withPermission.queryPermission({ mode })
    if (current === 'granted') return
  }
  throw new Error(t('syncPermissionDenied'))
}

async function persistDirectoryHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
  memoryDirectoryHandle = handle
  try {
    await setSyncDirectoryHandle(handle)
  } catch (error) {
    console.error(error)
  }
}

async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (memoryDirectoryHandle) return memoryDirectoryHandle
  try {
    const stored = await getSyncDirectoryHandle()
    if (stored) memoryDirectoryHandle = stored
    return stored
  } catch (error) {
    console.error(error)
    return null
  }
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
  const mode = localStorage.getItem(MODE_KEY) === 'handle' ? 'handle' : 'files'
  const canLink = canPickDirectory()
  return {
    canLinkFolder: canLink,
    supported: true,
    mode: canLink && mode === 'handle' ? 'handle' : 'files',
    folderName,
    linked: Boolean(folderName) || mode === 'handle',
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
  const handle = await loadDirectoryHandle()
  if (!handle) throw new Error(t('syncFolderNone'))
  await ensurePermission(handle, mode, { allowRequest: true })
  return handle
}

export async function chooseSyncFolder(): Promise<SyncStatus> {
  if (!canPickDirectory()) throw new Error(t('syncUseZip'))
  const handle = await window.showDirectoryPicker!({ id: 'pianosmith-library', mode: 'readwrite' })
  // Access was granted by the picker itself. Skipping requestPermission avoids Android
  // failures once the click gesture has been consumed by showDirectoryPicker.
  await ensurePermission(handle, 'readwrite', { allowRequest: false })
  localStorage.setItem(MODE_KEY, 'handle')
  localStorage.setItem(NAME_KEY, (handle.name || '').trim() || t('syncFolder'))
  await persistDirectoryHandle(handle)
  return getSyncStatus()
}

export async function disconnectSyncFolder(): Promise<SyncStatus> {
  await persistDirectoryHandle(null)
  localStorage.removeItem(NAME_KEY)
  localStorage.removeItem(LAST_KEY)
  localStorage.setItem(MODE_KEY, 'files')
  return getSyncStatus()
}

export async function restoreSyncLink(): Promise<SyncStatus> {
  const status = getSyncStatus()
  if (!status.canLinkFolder || localStorage.getItem(MODE_KEY) !== 'handle') return status
  try {
    const handle = await loadDirectoryHandle()
    if (!handle) {
      // Keep the saved folder name so the UI does not flash "not linked" after a successful
      // pick when IndexedDB could not round-trip the handle (common on Android Chrome).
      return getSyncStatus()
    }
    localStorage.setItem(MODE_KEY, 'handle')
    localStorage.setItem(NAME_KEY, (handle.name || '').trim() || status.folderName || t('syncFolder'))
  } catch {
    // Keep cached name; permission is requested on sync.
  }
  return getSyncStatus()
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function toUint8(data: ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return new Uint8Array(data)
}

export async function exportLibraryZip(): Promise<SyncResult> {
  const { manifest, files } = await buildLibraryBundle()
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_NAME]: toUint8(JSON.stringify(manifest, null, 2)),
  }
  for (const file of files) {
    entries[`${MEDIA_DIR}/${file.mediaName}`] = toUint8(file.data)
    entries[`${MEDIA_DIR}/${file.notesName}`] = toUint8(file.notesJson)
  }
  const zipped = zipSync(entries, { level: 6 })
  downloadBlob(new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), 'pianosmith-library.zip')
  const folderName = t('syncZipPackage')
  localStorage.setItem(MODE_KEY, 'files')
  localStorage.setItem(NAME_KEY, folderName)
  localStorage.setItem(LAST_KEY, String(manifest.updatedAt))
  return { pulled: 0, pushed: manifest.songs.length, folderName }
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function basename(path: string): string {
  const parts = normalizeArchivePath(path).split('/')
  return parts[parts.length - 1] || path
}

async function importFromFileMap(files: Map<string, Uint8Array | ArrayBuffer | string>): Promise<SyncResult> {
  const byBase = new Map<string, Uint8Array | ArrayBuffer | string>()
  let manifestRaw: string | null = null
  for (const [path, data] of files) {
    const norm = normalizeArchivePath(path)
    byBase.set(basename(norm), data)
    if (basename(norm) === MANIFEST_NAME || norm.endsWith(`/${MANIFEST_NAME}`)) {
      manifestRaw = typeof data === 'string' ? data : strFromU8(data instanceof Uint8Array ? data : new Uint8Array(data))
    }
  }
  const manifest = parseManifest(manifestRaw) as LibraryBundle
  if (!manifest.songs.length && !manifest.folders.length && !manifestRaw) {
    throw new Error(t('syncZipInvalid'))
  }
  const asBytes = (name: string): Promise<ArrayBuffer | null> => {
    const hit = byBase.get(name)
    if (!hit) return Promise.resolve(null)
    if (typeof hit === 'string') return Promise.resolve(toUint8(hit).buffer as ArrayBuffer)
    if (hit instanceof Uint8Array) {
      return Promise.resolve(hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) as ArrayBuffer)
    }
    return Promise.resolve(hit)
  }
  const asText = async (name: string): Promise<string | null> => {
    const hit = byBase.get(name)
    if (!hit) return null
    if (typeof hit === 'string') return hit
    return strFromU8(hit instanceof Uint8Array ? hit : new Uint8Array(hit))
  }
  const result = await importLibraryBundle(manifest, asBytes, asText)
  const folderName = t('syncZipPackage')
  localStorage.setItem(MODE_KEY, 'files')
  localStorage.setItem(NAME_KEY, folderName)
  localStorage.setItem(LAST_KEY, String(Date.now()))
  return { pulled: result.pulled, pushed: 0, folderName }
}

export async function importLibraryZip(file: File): Promise<SyncResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch {
    throw new Error(t('syncZipInvalid'))
  }
  const files = new Map<string, Uint8Array>()
  for (const [path, data] of Object.entries(unzipped)) files.set(path, data)
  return importFromFileMap(files)
}

/** Import from &lt;input webkitdirectory&gt; or a flat file list that includes the manifest. */
export async function importLibraryFiles(fileList: Iterable<File>): Promise<SyncResult> {
  const files = new Map<string, ArrayBuffer | string>()
  let seenManifest = false
  for (const file of fileList) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const name = basename(relative)
    if (name === MANIFEST_NAME) {
      seenManifest = true
      files.set(relative, await file.text())
    } else {
      files.set(relative, await file.arrayBuffer())
    }
  }
  if (!seenManifest) throw new Error(t('syncZipInvalid'))
  const folderHint = [...fileList][0] as File & { webkitRelativePath?: string } | undefined
  const top = folderHint?.webkitRelativePath?.split(/[/\\]/)[0]
  const result = await importFromFileMap(files)
  if (top) {
    localStorage.setItem(NAME_KEY, top)
    result.folderName = top
  }
  return result
}

export async function syncLibraryOrExport(): Promise<SyncResult> {
  const status = getSyncStatus()
  if (status.canLinkFolder && status.mode === 'handle') {
    try {
      return await syncLibrary()
    } catch {
      // Fall through to zip if the live folder handle is unavailable.
    }
  }
  return exportLibraryZip()
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
    const folderId = song.folderId || ''
    // Moves only change folderId/updatedAt — rewrite audio only when content identity changes.
    const needsMediaWrite =
      !remoteEntry || remoteEntry.media !== `${MEDIA_DIR}/${mediaName}` || remoteEntry.bytes !== song.bytes || remoteEntry.mime !== song.mime
    const needsNotesWrite = !remoteEntry || song.updatedAt > remoteEntry.updatedAt || needsMediaWrite
    const needsMetaWrite =
      !remoteEntry ||
      (remoteEntry.folderId || '') !== folderId ||
      remoteEntry.title !== song.title ||
      remoteEntry.updatedAt !== song.updatedAt
    if (needsMediaWrite) await writeFile(media, mediaName, song.data)
    if (needsNotesWrite) await writeFile(media, notesName, JSON.stringify(song.notes))
    if (needsMediaWrite || needsNotesWrite || needsMetaWrite) pushed += 1
    manifestSongs.push({
      id: song.id,
      title: song.title,
      kind: song.kind,
      source: song.source,
      mime: song.mime,
      bytes: song.bytes,
      duration: song.duration,
      folderId,
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
