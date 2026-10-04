import './style.css'
import { detectLink, fetchLink, linkServerAvailable, linkSourceName, serverBase } from './api'
import { DEMO_TITLE, demoNotes } from './demo'
import { Visualizer } from './engine'
import {
  ROOT_FOLDER_ID,
  countLibrarySongs,
  createFolder,
  fileSourceKey,
  folderOptions,
  folderPath,
  formatDuration,
  getLibrarySong,
  linkSourceKey,
  listFolders,
  listLibrarySongs,
  moveLibrarySong,
  removeFolder,
  removeLibrarySong,
  saveLibrarySong,
  type LibrarySongMeta,
} from './library'
import { isMidiFile, notesFromMidi, songToMidiBlob } from './midi'
import { renderPiano } from './piano'
import { Player } from './player'
import { canRecord, recordSong } from './record'
import { prepareNotes } from './theory'
import { transcribeAudio } from './transcribe'
import type { NoteEvent, RawNote } from './types'

const canvas = el<HTMLCanvasElement>('stage')
const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('Canvas non disponibile')

const viz = new Visualizer(ctx)
const gate = el<HTMLDivElement>('gate')
const topbar = el<HTMLDivElement>('topbar')
const titleEl = el<HTMLDivElement>('song-title')
const clock = el<HTMLSpanElement>('clock')
const scrub = el<HTMLInputElement>('scrub')
const playBtn = el<HTMLButtonElement>('play')
const speedBtn = el<HTMLButtonElement>('speed')
const namesBtn = el<HTMLButtonElement>('names')
const handsBtn = el<HTMLButtonElement>('hands')
const midiBtn = el<HTMLButtonElement>('midi')
const videoBtn = el<HTMLButtonElement>('video')
const resetBtn = el<HTMLButtonElement>('reset')
const fileInput = el<HTMLInputElement>('file')
const drop = el<HTMLLabelElement>('drop')
const ytInput = el<HTMLInputElement>('yt')
const panel = el<HTMLFormElement>('panel')
const hint = el<HTMLParagraphElement>('yt-hint')
const demoBtn = el<HTMLButtonElement>('demo')
const serverInput = el<HTMLInputElement>('server')
const statusEl = el<HTMLDivElement>('status')
const statusText = el<HTMLParagraphElement>('status-text')
const statusFill = el<HTMLDivElement>('status-fill')
const cancelBtn = el<HTMLButtonElement>('cancel')
const centerPlay = el<HTMLButtonElement>('center-play')
const recEl = el<HTMLDivElement>('rec')
const toastEl = el<HTMLDivElement>('toast')
const libraryOpenBtn = el<HTMLButtonElement>('library-open')
const libraryModal = el<HTMLDivElement>('library-modal')
const libraryPath = el<HTMLElement>('library-path')
const libraryBrowser = el<HTMLUListElement>('library-browser')
const libraryEmpty = el<HTMLParagraphElement>('library-empty')
const libraryNewFolderBtn = el<HTMLButtonElement>('library-new-folder')
const libraryFolderForm = el<HTMLFormElement>('library-folder-form')
const libraryFolderName = el<HTMLInputElement>('library-folder-name')

const RATES = [1, 0.75, 0.5]
let player: Player | null = null
let notes: NoteEvent[] | null = null
let songTitle = ''
let generation = 0
let currentAbort: AbortController | null = null
let recording = false
let scrubbing = false
let toastTimer = 0
let hideTimer = 0
let currentLibraryFolder = ROOT_FOLDER_ID
let libraryMoveOptions: Array<{ id: string; label: string }> = []

serverInput.value = localStorage.getItem('pianosmith.server') || ''
const namesOn = localStorage.getItem('pianosmith.names') === '1'
viz.setShowNames(namesOn)
namesBtn.setAttribute('aria-pressed', namesOn ? 'true' : 'false')
const handsOn = localStorage.getItem('pianosmith.hands') !== '0'
viz.setShowHands(handsOn)
handsBtn.setAttribute('aria-pressed', handsOn ? 'true' : 'false')

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Manca #${id}`)
  return node as T
}

function ensurePlayer() {
  if (!player) {
    player = new Player()
    player.onChange = () => syncUi()
  }
  return player
}

function fmt(time: number) {
  if (!Number.isFinite(time) || time < 0) time = 0
  const minutes = Math.floor(time / 60)
  const seconds = Math.floor(time % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function toast(message: string) {
  toastEl.hidden = false
  toastEl.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true
  }, 4600)
}

function setStatus(text: string, ratio: number | null) {
  statusEl.hidden = false
  statusText.textContent = text
  centerPlay.hidden = true
  if (ratio == null) {
    statusFill.classList.add('indeterminate')
    statusFill.style.width = '40%'
  } else {
    statusFill.classList.remove('indeterminate')
    statusFill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
  }
}

function hideStatus() {
  statusEl.hidden = true
}

function beginJob() {
  currentAbort?.abort()
  const gen = ++generation
  const controller = new AbortController()
  currentAbort = controller
  return { signal: controller.signal, alive: () => gen === generation }
}

function cancelJob() {
  generation++
  currentAbort?.abort()
  hideStatus()
  syncUi()
}

function fail(error: unknown) {
  hideStatus()
  const aborted = error instanceof DOMException && error.name === 'AbortError'
  if (aborted) return
  toast(error instanceof Error ? error.message : 'Qualcosa è andato storto')
  syncUi()
}

function fit() {
  if (recording) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
  viz.setViewport(window.innerWidth, window.innerHeight)
}

function poke() {
  if (recording) {
    topbar.classList.add('hidden')
    return
  }
  if (gate.hidden && notes) topbar.classList.remove('hidden')
  window.clearTimeout(hideTimer)
  if (player?.playing && gate.hidden) {
    hideTimer = window.setTimeout(() => topbar.classList.add('hidden'), 2800)
  }
}

function syncUi() {
  const hasSong = Boolean(notes && player)
  topbar.hidden = !hasSong
  titleEl.textContent = songTitle
  const time = player?.currentTime ?? 0
  const duration = player?.duration ?? 0
  clock.textContent = `${fmt(time)} / ${fmt(duration)}`
  if (!scrubbing && duration > 0) scrub.value = String(Math.round((time / duration) * 1000))
  playBtn.textContent = player?.playing ? 'Pausa' : 'Play'
  speedBtn.textContent = `${player?.rate ?? 1}×`
  if (recording) topbar.classList.add('hidden')
  else if (!player?.playing) topbar.classList.remove('hidden')
  const busy = !statusEl.hidden || recording
  centerPlay.hidden = !hasSong || Boolean(player?.playing) || !gate.hidden || busy
  playBtn.disabled = !hasSong || busy
  midiBtn.disabled = !hasSong || busy
  videoBtn.disabled = !hasSong || busy || !canRecord()
  scrub.disabled = !hasSong || busy
  if (player?.playing) poke()
}

async function startSong(title: string, nextNotes: NoteEvent[], buffer: AudioBuffer, alive: () => boolean) {
  if (!alive()) return
  if (nextNotes.length === 0) throw new Error('Non ho trovato note di pianoforte in questo audio')
  const transport = ensurePlayer()
  notes = nextNotes
  songTitle = title
  transport.pause()
  transport.buffer = buffer
  await transport.setRate(1)
  viz.setTitle(title)
  viz.setNotes(nextNotes)
  gate.hidden = true
  hideStatus()
  syncUi()
  poke()
  if (!alive()) return
  await transport.seek(0)
  await transport.play()
}

async function rememberSong(input: {
  title: string
  kind: 'audio' | 'midi'
  source: string
  mime: string
  data: ArrayBuffer
  notes: RawNote[]
  duration: number
}) {
  try {
    await saveLibrarySong(input)
    await refreshLibraryButton()
    if (!libraryModal.hidden) await renderLibraryBrowser()
  } catch (error) {
    console.error(error)
  }
}

function isMidiBytes(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false
  const head = new Uint8Array(data, 0, 4)
  return head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64
}

function libraryLabel(item: LibrarySongMeta): string {
  const kind = item.kind === 'midi' ? 'MIDI' : 'Audio'
  const duration = formatDuration(item.duration)
  return duration ? `${kind} · ${duration}` : kind
}

async function refreshLibraryButton() {
  try {
    const count = await countLibrarySongs()
    libraryOpenBtn.textContent = count > 0 ? `Brani salvati · ${count}` : 'Brani salvati'
  } catch (error) {
    console.error(error)
    libraryOpenBtn.textContent = 'Brani salvati'
  }
}

function hideFolderForm() {
  libraryFolderForm.hidden = true
  libraryFolderName.value = ''
  libraryNewFolderBtn.hidden = false
}

function showFolderForm() {
  libraryFolderForm.hidden = false
  libraryNewFolderBtn.hidden = true
  libraryFolderName.focus()
  libraryFolderName.select()
}

function renderLibraryPath(path: Array<{ id: string; name: string }>) {
  libraryPath.replaceChildren()
  const root = document.createElement('button')
  root.type = 'button'
  root.dataset.library = 'goto'
  root.dataset.id = ROOT_FOLDER_ID
  root.textContent = 'Brani salvati'
  if (!path.length) root.setAttribute('aria-current', 'page')
  libraryPath.append(root)
  for (const [index, folder] of path.entries()) {
    const sep = document.createElement('span')
    sep.textContent = '/'
    sep.className = 'library-meta'
    libraryPath.append(sep)
    const crumb = document.createElement('button')
    crumb.type = 'button'
    crumb.dataset.library = 'goto'
    crumb.dataset.id = folder.id
    crumb.textContent = folder.name
    if (index === path.length - 1) crumb.setAttribute('aria-current', 'page')
    libraryPath.append(crumb)
  }
}

function appendLibraryRow(options: {
  kind: 'folder' | 'song'
  id: string
  title: string
  meta: string
  folderId?: string
}) {
  const row = document.createElement('li')
  row.className = options.kind === 'folder' ? 'library-item is-folder' : 'library-item'

  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'library-main'
  main.dataset.library = options.kind === 'folder' ? 'enter' : 'open'
  main.dataset.id = options.id

  const title = document.createElement('span')
  title.className = 'library-title'
  title.textContent = options.title

  const meta = document.createElement('span')
  meta.className = 'library-meta'
  meta.textContent = options.meta

  main.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'library-actions'

  if (options.kind === 'song') {
    const move = document.createElement('select')
    move.className = 'library-move'
    move.dataset.library = 'move'
    move.dataset.id = options.id
    move.setAttribute('aria-label', `Sposta ${options.title}`)
    for (const option of libraryMoveOptions) {
      const node = document.createElement('option')
      node.value = option.id
      node.textContent = option.label
      if (option.id === (options.folderId || ROOT_FOLDER_ID)) node.selected = true
      move.append(node)
    }
    actions.append(move)
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'library-remove'
  remove.dataset.library = options.kind === 'folder' ? 'remove-folder' : 'remove'
  remove.dataset.id = options.id
  remove.setAttribute('aria-label', options.kind === 'folder' ? `Elimina cartella ${options.title}` : `Rimuovi ${options.title}`)
  remove.textContent = '×'
  actions.append(remove)

  row.append(main, actions)
  libraryBrowser.append(row)
}

async function renderLibraryBrowser() {
  try {
    const [folders, songs, path, moves] = await Promise.all([
      listFolders(currentLibraryFolder),
      listLibrarySongs(currentLibraryFolder),
      folderPath(currentLibraryFolder),
      folderOptions(),
    ])
    libraryMoveOptions = moves
    renderLibraryPath(path)
    libraryBrowser.replaceChildren()
    for (const folder of folders) {
      appendLibraryRow({
        kind: 'folder',
        id: folder.id,
        title: folder.name,
        meta: 'Cartella',
      })
    }
    for (const song of songs) {
      appendLibraryRow({
        kind: 'song',
        id: song.id,
        title: song.title,
        meta: libraryLabel(song),
        folderId: song.folderId,
      })
    }
    libraryEmpty.hidden = folders.length > 0 || songs.length > 0
  } catch (error) {
    console.error(error)
    toast(error instanceof Error ? error.message : 'Playlist non disponibile')
  }
}

async function openLibraryModal() {
  hideFolderForm()
  libraryModal.hidden = false
  await refreshLibraryButton()
  await renderLibraryBrowser()
  libraryOpenBtn.setAttribute('aria-expanded', 'true')
}

function closeLibraryModal() {
  libraryModal.hidden = true
  hideFolderForm()
  libraryOpenBtn.setAttribute('aria-expanded', 'false')
}

async function loadSaved(id: string) {
  closeLibraryModal()
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  try {
    setStatus('Apro il brano salvato…', null)
    const song = await getLibrarySong(id)
    if (!song) throw new Error('Brano non trovato nella playlist')
    if (!job.alive()) return
    const next = prepareNotes(song.notes)
    if (song.kind === 'midi') {
      setStatus('Genero il suono del pianoforte…', null)
      const buffer = await renderPiano(next)
      await startSong(song.title, next, buffer, job.alive)
      return
    }
    setStatus('Carico l’audio…', 0.08)
    const audio = await transport.decode(song.data.slice(0))
    if (!job.alive()) return
    await startSong(song.title, next, audio, job.alive)
  } catch (error) {
    if (!job.alive()) return
    fail(error)
  }
}

async function removeSaved(id: string) {
  try {
    await removeLibrarySong(id)
    await refreshLibraryButton()
    await renderLibraryBrowser()
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Non sono riuscito a rimuovere il brano')
  }
}

async function loadFile(file: File) {
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  const source = fileSourceKey(file)
  try {
    if (isMidiFile(file)) {
      setStatus('Leggo il MIDI…', null)
      const bytes = await file.arrayBuffer()
      const parsed = notesFromMidi(bytes)
      const next = prepareNotes(parsed.notes)
      if (!job.alive()) return
      setStatus('Genero il suono del pianoforte…', null)
      const buffer = await renderPiano(next)
      const title = file.name.replace(/\.(mid|midi)$/i, '') || parsed.title
      await startSong(title, next, buffer, job.alive)
      if (job.alive()) {
        void rememberSong({
          title,
          kind: 'midi',
          source,
          mime: file.type || 'audio/midi',
          data: bytes,
          notes: parsed.notes,
          duration: buffer.duration,
        })
      }
      return
    }
    if (file.size > 45 * 1024 * 1024) throw new Error('File troppo grande (massimo 45 MB)')
    setStatus('Carico l’audio…', 0.04)
    const bytes = await file.arrayBuffer()
    const audio = await transport.decode(bytes.slice(0))
    if (!job.alive()) return
    const raw = await transcribeAudio(audio, (label, ratio) => {
      if (job.alive()) setStatus(label, ratio)
    })
    if (!job.alive()) return
    const title = file.name.replace(/\.[^.]+$/, '') || 'Audio'
    await startSong(title, prepareNotes(raw), audio, job.alive)
    if (job.alive()) {
      void rememberSong({
        title,
        kind: 'audio',
        source,
        mime: file.type || 'application/octet-stream',
        data: bytes,
        notes: raw,
        duration: audio.duration,
      })
    }
  } catch (error) {
    if (!job.alive()) return
    fail(error)
  }
}

async function loadLink(url: string) {
  const sourceName = linkSourceName(url)
  if (!detectLink(url)) {
    toast('Incolla un link http o https')
    return
  }
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  const source = linkSourceKey(url)
  try {
    const fileSource =
      sourceName === 'file audio' ||
      /^(?:MIDI|MP3|WAV|FLAC|M4A|AAC|OGG|OPUS|OGA|WEBM|AIF|AIFF|WMA|ALAC|CAF)$/.test(sourceName)
    setStatus(fileSource ? 'Scarico il file…' : `Scarico l’audio da ${sourceName}…`, null)
    const downloaded = await fetchLink(url, job.signal)
    if (!job.alive()) return
    const bytes = await downloaded.blob.arrayBuffer()
    const midi = sourceName === 'MIDI' || downloaded.blob.type.includes('midi') || isMidiBytes(bytes)
    if (midi) {
      setStatus('Leggo il MIDI…', null)
      const parsed = notesFromMidi(bytes)
      const next = prepareNotes(parsed.notes)
      if (!job.alive()) return
      setStatus('Genero il suono del pianoforte…', null)
      const buffer = await renderPiano(next)
      const title = downloaded.title || parsed.title
      await startSong(title, next, buffer, job.alive)
      if (job.alive()) {
        void rememberSong({
          title,
          kind: 'midi',
          source,
          mime: downloaded.blob.type || 'audio/midi',
          data: bytes,
          notes: parsed.notes,
          duration: buffer.duration,
        })
      }
      return
    }
    if (bytes.byteLength > 45 * 1024 * 1024) throw new Error('File troppo grande (massimo 45 MB)')
    setStatus('Carico l’audio…', 0.05)
    const audio = await transport.decode(bytes.slice(0))
    if (!job.alive()) return
    const raw = await transcribeAudio(audio, (label, ratio) => {
      if (job.alive()) setStatus(label, ratio)
    })
    if (!job.alive()) return
    await startSong(downloaded.title, prepareNotes(raw), audio, job.alive)
    if (job.alive()) {
      void rememberSong({
        title: downloaded.title,
        kind: 'audio',
        source,
        mime: downloaded.blob.type || 'application/octet-stream',
        data: bytes,
        notes: raw,
        duration: audio.duration,
      })
    }
  } catch (error) {
    if (!job.alive()) return
    fail(error)
  }
}

async function loadDemo() {
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  try {
    setStatus('Preparo la demo…', null)
    const next = prepareNotes(demoNotes())
    const buffer = await renderPiano(next)
    await startSong(DEMO_TITLE, next, buffer, job.alive)
  } catch (error) {
    if (!job.alive()) return
    fail(error)
  }
}

async function exportVideo() {
  if (!player || !notes || recording) return
  if (!canRecord()) {
    toast('Questo browser non può registrare il video. Usa Chrome o Edge.')
    return
  }
  recording = true
  document.body.classList.add('recording')
  topbar.classList.add('hidden')
  centerPlay.hidden = true
  recEl.hidden = false
  player.pause()
  canvas.width = 1920
  canvas.height = 1080
  ctx!.setTransform(1, 0, 0, 1, 0, 0)
  viz.setViewport(1920, 1080)
  viz.render(0, 0.016)
  try {
    await player.seek(0)
    const blob = await recordSong(canvas, player, async () => {
      const ended = new Promise<void>((resolve) => {
        const previous = player!.onChange
        player!.onChange = () => {
          previous?.()
          if (!player!.playing && player!.currentTime >= player!.duration - 0.2) {
            player!.onChange = previous
            resolve()
          }
        }
      })
      await player!.play()
      await ended
    })
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
    download(blob, `${safeName(songTitle)}-piano.${ext}`)
  } catch (error) {
    fail(error)
  } finally {
    recEl.hidden = true
    recording = false
    document.body.classList.remove('recording')
    fit()
    syncUi()
    poke()
  }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function safeName(title: string) {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'pianosmith'
}

function showLibrary() {
  player?.pause()
  gate.hidden = false
  topbar.classList.remove('hidden')
  syncUi()
  void refreshLibraryButton()
}

libraryOpenBtn.setAttribute('aria-expanded', 'false')
libraryOpenBtn.addEventListener('click', () => {
  void openLibraryModal()
})

libraryModal.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest('[data-library]') as HTMLElement | null
  if (!target) return
  const action = target.dataset.library
  const id = target.dataset.id || ''
  if (action === 'close') {
    closeLibraryModal()
    return
  }
  if (action === 'goto') {
    currentLibraryFolder = id
    hideFolderForm()
    void renderLibraryBrowser()
    return
  }
  if (action === 'enter' && id) {
    currentLibraryFolder = id
    hideFolderForm()
    void renderLibraryBrowser()
    return
  }
  if (action === 'open' && id) {
    void loadSaved(id)
    return
  }
  if (action === 'remove' && id) {
    void removeSaved(id)
    return
  }
  if (action === 'remove-folder' && id) {
    void removeFolder(id)
      .then(async () => {
        if (currentLibraryFolder === id) currentLibraryFolder = ROOT_FOLDER_ID
        await renderLibraryBrowser()
      })
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : 'Non sono riuscito a eliminare la cartella')
      })
  }
})

libraryBrowser.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement | null
  if (!select || select.dataset.library !== 'move' || !select.dataset.id) return
  const songId = select.dataset.id
  const folderId = select.value
  void moveLibrarySong(songId, folderId)
    .then(renderLibraryBrowser)
    .catch((error: unknown) => {
      toast(error instanceof Error ? error.message : 'Non sono riuscito a spostare il brano')
      void renderLibraryBrowser()
    })
})

libraryNewFolderBtn.addEventListener('click', showFolderForm)
el<HTMLButtonElement>('library-folder-cancel').addEventListener('click', hideFolderForm)

libraryFolderForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void createFolder(libraryFolderName.value, currentLibraryFolder)
    .then(async () => {
      hideFolderForm()
      await renderLibraryBrowser()
    })
    .catch((error: unknown) => {
      toast(error instanceof Error ? error.message : 'Non sono riuscito a creare la cartella')
    })
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || libraryModal.hidden) return
  event.preventDefault()
  closeLibraryModal()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (file) void loadFile(file)
})

panel.addEventListener('submit', (event) => {
  event.preventDefault()
  void loadLink(ytInput.value)
})

demoBtn.addEventListener('click', () => {
  void loadDemo()
})

cancelBtn.addEventListener('click', cancelJob)
resetBtn.addEventListener('click', showLibrary)
playBtn.addEventListener('click', () => {
  void ensurePlayer().toggle()
})
centerPlay.addEventListener('click', () => {
  void ensurePlayer().toggle()
})
canvas.addEventListener('click', () => {
  if (!notes || !gate.hidden || !statusEl.hidden || recording) return
  void ensurePlayer().toggle()
})

speedBtn.addEventListener('click', () => {
  if (!player) return
  const index = RATES.indexOf(player.rate)
  const next = RATES[(index + 1) % RATES.length] ?? 1
  void player.setRate(next)
})

namesBtn.addEventListener('click', () => {
  const next = namesBtn.getAttribute('aria-pressed') !== 'true'
  namesBtn.setAttribute('aria-pressed', next ? 'true' : 'false')
  viz.setShowNames(next)
  localStorage.setItem('pianosmith.names', next ? '1' : '0')
})

handsBtn.addEventListener('click', () => {
  const next = handsBtn.getAttribute('aria-pressed') !== 'true'
  handsBtn.setAttribute('aria-pressed', next ? 'true' : 'false')
  viz.setShowHands(next)
  localStorage.setItem('pianosmith.hands', next ? '1' : '0')
})

midiBtn.addEventListener('click', () => {
  if (!notes) return
  download(songToMidiBlob(notes, songTitle), `${safeName(songTitle)}.mid`)
})

videoBtn.addEventListener('click', () => {
  void exportVideo()
})

scrub.addEventListener('pointerdown', () => {
  scrubbing = true
})
scrub.addEventListener('pointerup', () => {
  scrubbing = false
})
scrub.addEventListener('input', () => {
  if (!player || !player.duration) return
  void player.seek((Number(scrub.value) / 1000) * player.duration)
})

serverInput.addEventListener('change', () => {
  localStorage.setItem('pianosmith.server', serverInput.value.trim())
  void refreshLinkServer()
})

window.addEventListener('dragover', (event) => {
  event.preventDefault()
  drop.classList.add('hot')
})
window.addEventListener('dragleave', () => drop.classList.remove('hot'))
window.addEventListener('drop', (event) => {
  event.preventDefault()
  drop.classList.remove('hot')
  const file = event.dataTransfer?.files?.[0]
  if (file) void loadFile(file)
})

window.addEventListener('pointermove', poke)
window.addEventListener('keydown', (event) => {
  poke()
  if (recording) return
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (event.key === 'XF86Back' || event.key === 'GoBack' || event.keyCode === 10009) {
    if (gate.hidden) {
      event.preventDefault()
      showLibrary()
    }
    return
  }
  if (!gate.hidden || !notes) return
  if (event.key === ' ' || event.key === 'MediaPlayPause' || event.key === 'XF86AudioPlay' || event.key === 'XF86AudioPause') {
    event.preventDefault()
    void ensurePlayer().toggle()
  }
})

window.addEventListener('resize', fit)

function registerRemote() {
  const tv = (window as Window & { tizen?: { tvinputdevice?: { registerKeyBatch?: (keys: string[]) => void } } }).tizen
  try {
    tv?.tvinputdevice?.registerKeyBatch?.(['MediaPlay', 'MediaPause', 'MediaPlayPause', 'Exit'])
  } catch {
    /* browser */
  }
}

async function refreshLinkServer() {
  const base = serverBase()
  const ok = await linkServerAvailable()
  if (ok) {
    hint.textContent = base ? `Link musicali tramite ${base}` : 'Link musicali pronti su questo computer.'
    return
  }
  hint.textContent = base
    ? 'Server non raggiungibile. Controlla l’indirizzo e che PianoSmith sia avviato.'
    : 'I link richiedono il server sul computer (yt-dlp). I file audio funzionano lo stesso.'
}

function showDetectedLink() {
  const name = linkSourceName(ytInput.value)
  const label = document.getElementById('link-kind')
  if (!label) return
  label.textContent = name ? `Riconosciuto: ${name}` : ''
}

ytInput.addEventListener('input', showDetectedLink)

fit()
syncUi()
registerRemote()
void refreshLinkServer()
void refreshLibraryButton()

let last = performance.now()
function loop(now: number) {
  const dt = (now - last) / 1000
  last = now
  try {
    viz.render(player?.currentTime ?? 0, dt)
  } catch (error) {
    console.error(error)
  }
  if (player && notes && !scrubbing) {
    const duration = player.duration
    clock.textContent = `${fmt(player.currentTime)} / ${fmt(duration)}`
    if (duration > 0) scrub.value = String(Math.round((player.currentTime / duration) * 1000))
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

if (import.meta.env.DEV) {
  Object.assign(window, {
    pianoSmith: {
      viz,
      get player() {
        return player
      },
      prepareNotes,
      transcribeAudio,
      renderPiano,
    },
  })
}
