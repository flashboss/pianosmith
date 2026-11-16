import { strFromU8, unzipSync, zipSync } from 'fflate'
import { t } from './i18n'
import {
  ROOT_FOLDER_ID,
  deleteFolderRecord,
  getSyncDirectoryHandle,
  listAllFolders,
  listAllLibrarySongs,
  putLibrarySong,
  removeLibrarySong,
  setSyncDirectoryHandle,
  upsertFolder,
  type LibraryFolder,
  type LibrarySong,
} from './library'
import type { RawNote } from './types'

const MANIFEST_NAME = 'pianosmith-library.json'
const DELETED_NAME = 'pianosmith-deleted.json'
const MEDIA_DIR = 'media'
const AUTO_KEY = 'pianosmith.sync.auto'
const NAME_KEY = 'pianosmith.sync.folderName'
const LAST_KEY = 'pianosmith.sync.lastAt'
const MODE_KEY = 'pianosmith.sync.mode'
const TOMBSTONE_KEY = 'pianosmith.sync.tombstones'

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
  /** Shared delete ledger so other devices can drop songs on import/sync. */
  deleted?: Record<string, number>
}

export type SyncResult = {
  pulled: number
  pushed: number
  folderName: string
  /** Remote songs skipped because media files were missing/unreadable. */
  skippedMedia?: number
  /** Folders written into IndexedDB after coalesce. */
  foldersUpserted?: number
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
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return false
  // Android Chrome advertises showDirectoryPicker, but OPEN_DOCUMENT_TREE often ends in
  // AbortError or a handle that cannot be persisted — use ZIP / Import folder there.
  if (/Android/i.test(navigator.userAgent || '')) return false
  return true
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

function parseDeletedMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { deleted?: Record<string, number> } | Record<string, number>
    if (!parsed || typeof parsed !== 'object') return {}
    const map =
      'deleted' in parsed && parsed.deleted && typeof parsed.deleted === 'object'
        ? parsed.deleted
        : (parsed as Record<string, number>)
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(map)) {
      if (key && Number.isFinite(value)) out[key] = Number(value)
    }
    return out
  } catch {
    return {}
  }
}

function mergeDeletedMaps(...maps: Array<Record<string, number> | undefined>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const map of maps) {
    if (!map) continue
    for (const [key, value] of Object.entries(map)) {
      if (!key || !Number.isFinite(value)) continue
      out[key] = Math.max(out[key] || 0, value)
    }
  }
  return out
}

async function applySharedDeletions(deleted: Record<string, number>): Promise<number> {
  if (!Object.keys(deleted).length) return 0
  const local = readTombstones()
  writeTombstones(mergeDeletedMaps(local, deleted))
  let removed = 0
  const songs = await listAllLibrarySongs()
  for (const song of songs) {
    const key = songKey(song)
    const deletedAt = deleted[key]
    if (!deletedAt) continue
    if (song.updatedAt > deletedAt) continue
    await removeLibrarySong(song.id)
    removed += 1
  }
  return removed
}

/** Drop local songs that are not present in the imported/shared package. */
async function pruneAbsentSongs(keepKeys: Set<string>): Promise<number> {
  let removed = 0
  const songs = await listAllLibrarySongs()
  for (const song of songs) {
    const key = songKey(song)
    if (keepKeys.has(key)) continue
    rememberDeletedSong(song)
    await removeLibrarySong(song.id)
    removed += 1
  }
  return removed
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
  const source = (song.source || '').trim()
  const youtube = source.match(/(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i)
  if (youtube) return `yt:${youtube[1]}`
  const spotify = source.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|episode)\/([a-zA-Z0-9]+)/i)
  if (spotify) return `spotify:${spotify[1]}`
  return source || `id:${song.id}`
}

function readTombstones(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, number>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeTombstones(map: Record<string, number>): void {
  localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(map))
}

/** Remember a local delete so sync does not resurrect the song from the shared folder. */
export function rememberDeletedSong(song: { source: string; id: string }): void {
  const key = songKey(song)
  if (!key) return
  const map = readTombstones()
  map[key] = Date.now()
  writeTombstones(map)
}

/** Clear tombstone when the user saves/imports the same song again. */
export function clearDeletedSong(song: { source: string; id: string }): void {
  const key = songKey(song)
  if (!key) return
  const map = readTombstones()
  if (!(key in map)) return
  delete map[key]
  writeTombstones(map)
}

function isTombstoned(key: string, remoteUpdatedAt = 0): boolean {
  const at = readTombstones()[key]
  if (!at) return false
  // A newer remote copy (re-added elsewhere) can revive the song.
  return at >= remoteUpdatedAt
}

async function removeFileIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch {
    /* missing is fine */
  }
}

function folderGroupKey(parentId: string, name: string): string {
  return `${parentId || ROOT_FOLDER_ID}\0${name.trim().toLowerCase()}`
}

function resolveFolderId(id: string, remap: Map<string, string>): string {
  let current = id || ROOT_FOLDER_ID
  const seen = new Set<string>()
  while (remap.has(current)) {
    const next = remap.get(current)!
    if (next === current || seen.has(current)) break
    seen.add(current)
    current = next
  }
  return current || ROOT_FOLDER_ID
}

/**
 * Merge folders that share the same parent + name (case-insensitive).
 * Different devices often create "Queen" with different ids — keep one and remap.
 */
function coalesceFolders(
  folders: LibraryFolder[],
  preferIds?: Set<string>,
): { folders: LibraryFolder[]; remap: Map<string, string> } {
  const remap = new Map<string, string>()
  const byId = new Map<string, LibraryFolder>()
  for (const folder of folders) {
    if (!folder?.id) continue
    const normalized: LibraryFolder = {
      ...folder,
      parentId: folder.parentId || ROOT_FOLDER_ID,
      name: folder.name.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
    }
    if (!normalized.name) continue
    const prev = byId.get(normalized.id)
    if (!prev || normalized.updatedAt >= prev.updatedAt) byId.set(normalized.id, normalized)
  }

  let changed = true
  while (changed) {
    changed = false
    const groups = new Map<string, LibraryFolder[]>()
    for (const folder of byId.values()) {
      const parent = resolveFolderId(folder.parentId, remap)
      const key = folderGroupKey(parent, folder.name)
      const list = groups.get(key) || []
      list.push(folder)
      groups.set(key, list)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      group.sort((a, b) => {
        const aPref = preferIds?.has(a.id) ? 0 : 1
        const bPref = preferIds?.has(b.id) ? 0 : 1
        if (aPref !== bPref) return aPref - bPref
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id.localeCompare(b.id)
      })
      const winner = group[0]
      const updatedAt = Math.max(...group.map((row) => row.updatedAt))
      byId.set(winner.id, {
        ...winner,
        parentId: resolveFolderId(winner.parentId, remap),
        updatedAt,
      })
      for (let i = 1; i < group.length; i += 1) {
        const loser = group[i]
        remap.set(loser.id, winner.id)
        byId.delete(loser.id)
        changed = true
      }
    }
  }

  for (const folder of byId.values()) {
    folder.parentId = resolveFolderId(folder.parentId, remap)
  }
  return { folders: [...byId.values()], remap }
}

async function applyFolderRemap(
  remap: Map<string, string>,
  songs: Array<{ folderId: string }>,
): Promise<void> {
  if (!remap.size) return
  for (const song of songs) {
    const next = resolveFolderId(song.folderId || ROOT_FOLDER_ID, remap)
    if (next !== (song.folderId || ROOT_FOLDER_ID)) song.folderId = next
  }
  for (const [loserId, winnerId] of remap) {
    if (loserId && loserId !== winnerId) await deleteFolderRecord(loserId)
  }
}

/**
 * Merge local same-named sibling folders, remap songs, repair orphans, drop
 * duplicate source keys. Needed on TV (bridge coalesce only runs on the receiver)
 * and on PC when folder merges leave a song pointing at a deleted folder id —
 * that song still counts in "Brani salvati · N" but is invisible in the browser.
 */
export async function healLibraryFolders(): Promise<{
  merged: number
  folders: number
  orphans: number
  duplicates: number
}> {
  const localFolders = await listAllFolders()
  const localSongs = await listAllLibrarySongs()
  const prefer = new Set(localFolders.map((folder) => folder.id))
  const { folders: coalesced, remap } = coalesceFolders(localFolders, prefer)
  for (const folder of coalesced) await upsertFolder(folder)
  for (const song of localSongs) {
    const next = resolveFolderId(song.folderId || ROOT_FOLDER_ID, remap)
    if (next !== (song.folderId || ROOT_FOLDER_ID)) {
      await putLibrarySong({ ...song, folderId: next })
    }
  }
  await applyFolderRemap(remap, [])

  const folderIds = new Set(coalesced.map((folder) => folder.id))
  folderIds.add(ROOT_FOLDER_ID)
  let orphans = 0
  const afterRemap = await listAllLibrarySongs()
  for (const song of afterRemap) {
    const folderId = song.folderId || ROOT_FOLDER_ID
    if (folderId && !folderIds.has(folderId)) {
      // Folder was removed in a prior merge — surface the song at root so it is reachable.
      await putLibrarySong({ ...song, folderId: ROOT_FOLDER_ID })
      orphans += 1
    }
  }

  let duplicates = 0
  const byKey = new Map<string, LibrarySong[]>()
  for (const song of await listAllLibrarySongs()) {
    const key = songKey(song)
    const list = byKey.get(key) || []
    list.push(song)
    byKey.set(key, list)
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    for (let i = 1; i < group.length; i += 1) {
      await removeLibrarySong(group[i].id)
      duplicates += 1
    }
  }

  if (remap.size || orphans || duplicates) {
    console.info('[pianosmith heal library]', {
      merged: remap.size,
      orphans,
      duplicates,
      remap: [...remap.entries()],
      folders: coalesced.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
    })
  }
  return { merged: remap.size, folders: coalesced.length, orphans, duplicates }
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
  localStorage.setItem(LAST_KEY, String(manifest.updatedAt))
  const status = getSyncStatus()
  // ZIP is transport only — never replace the linked shared folder.
  return { pulled: 0, pushed: manifest.songs.length, folderName: status.folderName || t('syncFolder') }
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function basename(path: string): string {
  const parts = normalizeArchivePath(path).split('/')
  return parts[parts.length - 1] || path
}

function archiveDataToU8(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return toUint8(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

function archiveDataToText(data: Uint8Array | ArrayBuffer | string): string {
  if (typeof data === 'string') return data
  return strFromU8(data instanceof Uint8Array ? data : new Uint8Array(data))
}

function archiveDataToBuffer(data: Uint8Array | ArrayBuffer | string): ArrayBuffer {
  if (typeof data === 'string') return toUint8(data).buffer as ArrayBuffer
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  return data
}

type ArchiveIndex = {
  byBase: Map<string, Uint8Array | ArrayBuffer | string>
  manifestRaw: string | null
  manifest: SyncManifest
  deleted: Record<string, number>
}

function indexArchiveFiles(files: Map<string, Uint8Array | ArrayBuffer | string>): ArchiveIndex {
  const byBase = new Map<string, Uint8Array | ArrayBuffer | string>()
  let manifestRaw: string | null = null
  let deletedRaw: string | null = null
  for (const [path, data] of files) {
    const norm = normalizeArchivePath(path)
    const base = basename(norm)
    byBase.set(base, data)
    if (base === MANIFEST_NAME || norm.endsWith(`/${MANIFEST_NAME}`)) {
      manifestRaw = archiveDataToText(data)
    }
    if (base === DELETED_NAME || norm.endsWith(`/${DELETED_NAME}`)) {
      deletedRaw = archiveDataToText(data)
    }
  }
  const manifest = parseManifest(manifestRaw)
  if (!manifest.songs.length && !manifest.folders.length && !manifestRaw) {
    throw new Error(t('syncZipInvalid'))
  }
  const deleted = mergeDeletedMaps(manifest.deleted, parseDeletedMap(deletedRaw))
  return { byBase, manifestRaw, manifest, deleted }
}

/** Merge archive songs/media into the linked shared folder (never replaces the folder link). */
async function depositArchiveIntoSharedFolder(
  dir: FileSystemDirectoryHandle,
  files: Map<string, Uint8Array | ArrayBuffer | string>,
): Promise<number> {
  const { byBase, manifest: incoming } = indexArchiveFiles(files)
  const media = await dir.getDirectoryHandle(MEDIA_DIR, { create: true })
  const remote = parseManifest(await readTextFile(dir, MANIFEST_NAME))

  const foldersById = new Map<string, LibraryFolder>()
  for (const folder of [...remote.folders, ...incoming.folders]) {
    const prev = foldersById.get(folder.id)
    if (!prev || folder.updatedAt >= prev.updatedAt) foldersById.set(folder.id, folder)
  }
  const preferRemote = new Set(remote.folders.map((folder) => folder.id))
  const { folders: coalescedFolders, remap: folderRemap } = coalesceFolders(
    [...foldersById.values()],
    preferRemote,
  )

  const mergedSongs = new Map<string, SyncSongEntry>()
  for (const song of remote.songs) {
    mergedSongs.set(songKey(song), {
      ...song,
      folderId: resolveFolderId(song.folderId || ROOT_FOLDER_ID, folderRemap),
    })
  }

  let deposited = 0
  for (const entry of incoming.songs) {
    const key = songKey(entry)
    const existing = mergedSongs.get(key)
    if (existing && existing.updatedAt >= entry.updatedAt) continue
    const mediaName = basename(entry.media || '')
    const notesName = basename(entry.notes || '')
    if (!mediaName || !notesName) continue
    const mediaData = byBase.get(mediaName)
    if (!mediaData) continue
    await writeFile(media, mediaName, new Uint8Array(archiveDataToU8(mediaData)))
    const notesData = byBase.get(notesName)
    if (notesData) await writeFile(media, notesName, new Uint8Array(archiveDataToU8(notesData)))
    mergedSongs.set(key, {
      ...entry,
      folderId: resolveFolderId(entry.folderId || ROOT_FOLDER_ID, folderRemap),
      media: `${MEDIA_DIR}/${mediaName}`,
      notes: `${MEDIA_DIR}/${notesName}`,
    })
    deposited += 1
  }

  const manifest: SyncManifest = {
    version: 1,
    updatedAt: Date.now(),
    folders: coalescedFolders.sort((a, b) => a.name.localeCompare(b.name)),
    songs: [...mergedSongs.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
  }
  await writeFile(dir, MANIFEST_NAME, JSON.stringify(manifest, null, 2))
  return deposited
}

async function ensureWritableSharedFolder(): Promise<FileSystemDirectoryHandle> {
  const status = getSyncStatus()
  if (!status.canLinkFolder) throw new Error(t('syncZipNeedsFolder'))
  if (status.mode !== 'handle') {
    await chooseSyncFolder()
  }
  return linkedDirectory('readwrite')
}

async function importFromFileMap(files: Map<string, Uint8Array | ArrayBuffer | string>): Promise<SyncResult> {
  const { byBase, manifest, deleted } = indexArchiveFiles(files)
  const asBytes = (name: string): Promise<ArrayBuffer | null> => {
    const hit = byBase.get(name)
    if (!hit) return Promise.resolve(null)
    return Promise.resolve(archiveDataToBuffer(hit))
  }
  const asText = async (name: string): Promise<string | null> => {
    const hit = byBase.get(name)
    if (!hit) return null
    return archiveDataToText(hit)
  }
  // Folder/ZIP import mirrors the package: apply shared deletes and drop local songs
  // that are no longer in the package (fixes phone still showing PC-deleted tracks).
  const result = await importLibraryBundle(manifest as LibraryBundle, asBytes, asText, {
    deleted,
    pruneAbsent: true,
  })
  localStorage.setItem(LAST_KEY, String(Date.now()))
  const status = getSyncStatus()
  // Do not switch sync mode / folder name — ZIP/folder dumps must not replace the shared folder.
  return { pulled: result.pulled, pushed: 0, folderName: status.folderName || t('syncFolder') }
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

  const dir = await ensureWritableSharedFolder()
  const deposited = await depositArchiveIntoSharedFolder(dir, files)
  const synced = await syncLibrary()
  return {
    pulled: synced.pulled,
    pushed: Math.max(synced.pushed, deposited),
    folderName: synced.folderName,
  }
}

/** Import from &lt;input webkitdirectory&gt; or a flat file list that includes the manifest. */
export async function importLibraryFiles(fileList: Iterable<File>): Promise<SyncResult> {
  const files = new Map<string, ArrayBuffer | string>()
  let seenManifest = false
  for (const file of fileList) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const name = basename(relative)
    if (name === MANIFEST_NAME || name === DELETED_NAME) {
      if (name === MANIFEST_NAME) seenManifest = true
      files.set(relative, await file.text())
    } else {
      files.set(relative, await file.arrayBuffer())
    }
  }
  if (!seenManifest) throw new Error(t('syncZipInvalid'))

  const status = getSyncStatus()
  if (status.canLinkFolder && status.mode === 'handle') {
    const dir = await linkedDirectory('readwrite')
    const deposited = await depositArchiveIntoSharedFolder(dir, files)
    const synced = await syncLibrary()
    return {
      pulled: synced.pulled,
      pushed: Math.max(synced.pushed, deposited),
      folderName: synced.folderName,
    }
  }

  // No live shared folder (e.g. Android): pull into the local library only.
  return importFromFileMap(files)
}

export async function syncLibraryOrExport(): Promise<SyncResult> {
  return syncLibrary()
}

export async function buildLibraryBundle(): Promise<{
  manifest: LibraryBundle
  files: LibraryBundleSongFiles[]
}> {
  // Heal before export/bridge push so the sender also drops duplicate folders.
  await healLibraryFolders()
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
  options: { deleted?: Record<string, number>; pruneAbsent?: boolean } = {},
): Promise<{ pulled: number; removed?: number }> {
  const sharedDeleted = mergeDeletedMaps(
    options.deleted,
    (manifest as SyncManifest).deleted,
    readTombstones(),
  )
  await applySharedDeletions(sharedDeleted)

  const localFolders = await listAllFolders()
  const localSongs = await listAllLibrarySongs()
  const foldersById = new Map<string, LibraryFolder>()
  for (const folder of [...(manifest.folders || []), ...localFolders]) {
    const prev = foldersById.get(folder.id)
    if (!prev || folder.updatedAt >= prev.updatedAt) foldersById.set(folder.id, folder)
  }
  const preferLocal = new Set(localFolders.map((folder) => folder.id))
  const { folders: coalescedFolders, remap: folderRemap } = coalesceFolders(
    [...foldersById.values()],
    preferLocal,
  )

  for (const folder of coalescedFolders) await upsertFolder(folder)

  for (const song of localSongs) {
    const next = resolveFolderId(song.folderId || ROOT_FOLDER_ID, folderRemap)
    if (next !== (song.folderId || ROOT_FOLDER_ID)) {
      song.folderId = next
      await putLibrarySong(song)
    }
  }
  await applyFolderRemap(folderRemap, [])

  let pulled = 0
  const keepKeys = new Set<string>()
  const localByKey = new Map((await listAllLibrarySongs()).map((song) => [songKey(song), song]))
  for (const entry of manifest.songs || []) {
    const key = songKey(entry)
    keepKeys.add(key)
    if (isTombstoned(key, entry.updatedAt || 0)) continue
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
      folderId: resolveFolderId(entry.folderId || ROOT_FOLDER_ID, folderRemap),
      createdAt: entry.createdAt || entry.updatedAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
      data,
      notes,
    }
    await putLibrarySong(imported)
    clearDeletedSong(imported)
    pulled += 1
  }

  let removed = 0
  if (options.pruneAbsent) {
    removed = await pruneAbsentSongs(keepKeys)
  }
  return { pulled, removed }
}

export async function syncLibrary(): Promise<SyncResult> {
  const dir = await linkedDirectory('readwrite')
  const media = await dir.getDirectoryHandle(MEDIA_DIR, { create: true })
  const remote = parseManifest(await readTextFile(dir, MANIFEST_NAME))
  const remoteDeleted = mergeDeletedMaps(
    remote.deleted,
    parseDeletedMap(await readTextFile(dir, DELETED_NAME)),
    readTombstones(),
  )
  await applySharedDeletions(remoteDeleted)

  const localFolders = await listAllFolders()
  const localSongs = await listAllLibrarySongs()
  const foldersById = new Map<string, LibraryFolder>()
  for (const folder of [...remote.folders, ...localFolders]) {
    const prev = foldersById.get(folder.id)
    if (!prev || folder.updatedAt >= prev.updatedAt) foldersById.set(folder.id, folder)
  }
  // Ensure every song folderId has a folder row (manifest may omit it).
  for (const entry of remote.songs) {
    const id = entry.folderId || ROOT_FOLDER_ID
    if (!id || foldersById.has(id)) continue
    foldersById.set(id, {
      id,
      name: id.slice(0, 8),
      parentId: ROOT_FOLDER_ID,
      createdAt: entry.createdAt || entry.updatedAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
    })
  }
  const preferLocal = new Set(localFolders.map((folder) => folder.id))
  const { folders: coalescedFolders, remap: folderRemap } = coalesceFolders(
    [...foldersById.values()],
    preferLocal,
  )
  const coalescedById = new Map(coalescedFolders.map((folder) => [folder.id, folder]))

  // Always rewrite folder rows after coalesce so parentIds heal (e.g. Magic under the kept Queen).
  for (const folder of coalescedFolders) await upsertFolder(folder)
  await applyFolderRemap(folderRemap, [])

  let pulled = 0
  let skippedMedia = 0
  const localByKey = new Map(localSongs.map((song) => [songKey(song), song]))
  const mergedSongs = new Map<string, LibrarySong>()
  const retainedRemote = new Map<string, SyncSongEntry>()

  for (const song of localSongs) {
    const folderId = resolveFolderId(song.folderId || ROOT_FOLDER_ID, folderRemap)
    const remapped = folderId === (song.folderId || ROOT_FOLDER_ID) ? song : { ...song, folderId }
    if (remapped !== song) await putLibrarySong(remapped)
    mergedSongs.set(songKey(remapped), remapped)
  }

  for (const entry of remote.songs) {
    const key = songKey(entry)
    const folderId = resolveFolderId(entry.folderId || ROOT_FOLDER_ID, folderRemap)
    const remappedEntry: SyncSongEntry = { ...entry, folderId }
    if (isTombstoned(key, entry.updatedAt || 0)) {
      // Local delete wins: drop remote media and keep it out of the rewritten manifest.
      const mediaName = entry.media?.split('/').pop() || entry.media
      const notesName = entry.notes?.split('/').pop() || entry.notes
      if (mediaName) await removeFileIfExists(media, mediaName)
      if (notesName) await removeFileIfExists(media, notesName)
      continue
    }
    const local = localByKey.get(key)
    if (local && local.updatedAt >= entry.updatedAt) {
      // Keep local bytes; still remember remapped folder if local missed a move.
      const localMerged = mergedSongs.get(key)
      if (localMerged && localMerged.folderId !== folderId && entry.updatedAt >= localMerged.updatedAt) {
        const moved = { ...localMerged, folderId }
        await putLibrarySong(moved)
        mergedSongs.set(key, moved)
      }
      continue
    }
    const mediaName = entry.media?.split('/').pop() || entry.media
    const notesName = entry.notes?.split('/').pop() || entry.notes
    if (!mediaName || !notesName) {
      skippedMedia += 1
      retainedRemote.set(key, remappedEntry)
      console.warn('[pianosmith sync] skip song (missing media names)', entry.title, entry.media, entry.notes)
      continue
    }
    const data = await readBinaryFile(media, mediaName)
    if (!data) {
      skippedMedia += 1
      retainedRemote.set(key, remappedEntry)
      console.warn('[pianosmith sync] skip song (unreadable media — is the Drive file online-only?)', entry.title, mediaName)
      continue
    }
    const notes = parseNotes(await readTextFile(media, notesName))
    const imported: LibrarySong = {
      id: local?.id || entry.id,
      title: entry.title,
      kind: entry.kind,
      source: entry.source,
      mime: entry.mime,
      bytes: data.byteLength,
      duration: entry.duration,
      folderId,
      createdAt: entry.createdAt || entry.updatedAt || Date.now(),
      updatedAt: entry.updatedAt || Date.now(),
      data,
      notes,
    }
    await putLibrarySong(imported)
    clearDeletedSong(imported)
    if (imported.folderId) {
      const folder = coalescedById.get(imported.folderId)
      if (folder) await upsertFolder(folder)
    }
    mergedSongs.set(key, imported)
    pulled += 1
  }

  const finalSongs = [...mergedSongs.values()]
  let pushed = 0
  const remoteByKey = new Map(remote.songs.map((song) => [songKey(song), song]))
  const manifestSongs: SyncSongEntry[] = []
  const seenKeys = new Set<string>()

  for (const song of finalSongs) {
    const key = songKey(song)
    seenKeys.add(key)
    const fileId = safeFileId(song.id)
    const ext = extensionFor(song.mime, song.kind)
    const mediaName = `${fileId}.${ext}`
    const notesName = `${fileId}.notes.json`
    const remoteEntry = remoteByKey.get(key)
    const folderId = resolveFolderId(song.folderId || ROOT_FOLDER_ID, folderRemap)
    // Moves only change folderId/updatedAt — rewrite audio only when content identity changes.
    const needsMediaWrite =
      !remoteEntry || remoteEntry.media !== `${MEDIA_DIR}/${mediaName}` || remoteEntry.bytes !== song.bytes || remoteEntry.mime !== song.mime
    const needsNotesWrite = !remoteEntry || song.updatedAt > remoteEntry.updatedAt || needsMediaWrite
    const needsMetaWrite =
      !remoteEntry ||
      resolveFolderId(remoteEntry.folderId || ROOT_FOLDER_ID, folderRemap) !== folderId ||
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

  // Keep remote-only songs whose media was temporarily unreadable — but never
  // resurrect locally deleted (tombstoned) tracks.
  for (const [key, entry] of retainedRemote) {
    if (seenKeys.has(key) || isTombstoned(key, entry.updatedAt || 0)) continue
    seenKeys.add(key)
    manifestSongs.push(entry)
  }

  const deleted = mergeDeletedMaps(remoteDeleted, readTombstones())
  // Drop tombstones for songs we still keep so a revive path stays clean.
  for (const song of manifestSongs) delete deleted[songKey(song)]
  writeTombstones(deleted)

  const manifest: SyncManifest = {
    version: 1,
    updatedAt: Date.now(),
    folders: coalescedFolders.sort((a, b) => a.name.localeCompare(b.name)),
    songs: manifestSongs.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)),
    deleted,
  }
  await writeFile(dir, MANIFEST_NAME, JSON.stringify(manifest, null, 2))
  await writeFile(
    dir,
    DELETED_NAME,
    JSON.stringify({ version: 1, updatedAt: manifest.updatedAt, deleted }, null, 2),
  )

  const folderName = dir.name || localStorage.getItem(NAME_KEY) || t('syncFolder')
  localStorage.setItem(NAME_KEY, folderName)
  localStorage.setItem(LAST_KEY, String(manifest.updatedAt))

  console.info('[pianosmith sync]', {
    remoteSongs: remote.songs.length,
    remoteFolders: remote.folders.length,
    localSongs: localSongs.length,
    pulled,
    pushed,
    skippedMedia,
    foldersUpserted: coalescedFolders.length,
    deleted: Object.keys(deleted).length,
    folderRemap: [...folderRemap.entries()],
    coalesced: coalescedFolders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
  })

  return {
    pulled,
    pushed,
    folderName,
    skippedMedia,
    foldersUpserted: coalescedFolders.length,
  }
}
