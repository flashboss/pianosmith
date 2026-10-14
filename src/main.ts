import './style.css'
import { initI18n, t } from './i18n'
import { detectLink, fetchLink, linkServerAvailable, linkSourceName, serverBase, serverFieldValue } from './api'
import { demoNotes } from './demo'
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

initI18n()

const canvas = el<HTMLCanvasElement>('stage')
const ctx = canvas.getContext('2d')
if (!ctx) throw new Error(t('canvasMissing'))

const viz = new Visualizer(ctx)
const gate = el<HTMLDivElement>('gate')
const gateCloseBtn = el<HTMLButtonElement>('gate-close')
const topbar = el<HTMLDivElement>('topbar')
const titleEl = el<HTMLDivElement>('song-title')
const clock = el<HTMLSpanElement>('clock')
const scrub = el<HTMLInputElement>('scrub')
const seekBackBtn = el<HTMLButtonElement>('seek-back')
const seekForwardBtn = el<HTMLButtonElement>('seek-forward')
const seekStepBtn = el<HTMLButtonElement>('seek-step')
const playBtn = el<HTMLButtonElement>('play')
const settingsOpenBtn = el<HTMLButtonElement>('settings-open')
const settingsModal = el<HTMLDivElement>('settings-modal')
const settingsCloseBtn = el<HTMLButtonElement>('settings-close')
const speedBtn = el<HTMLButtonElement>('speed')
const namesBtn = el<HTMLButtonElement>('names')
const handsBtn = el<HTMLButtonElement>('hands')
const zoomBtn = el<HTMLButtonElement>('zoom')
const midiBtn = el<HTMLButtonElement>('midi')
const sheetBtn = el<HTMLButtonElement>('sheet')
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
const SEEK_STEPS = [1, 2, 5, 10]
function loadSeekStep() {
  const saved = Number(localStorage.getItem('pianosmith.seekStep'))
  return SEEK_STEPS.includes(saved) ? saved : 2
}
let seekStep = loadSeekStep()
let player: Player | null = null
let notes: NoteEvent[] | null = null
let songTitle = ''
let generation = 0
let currentAbort: AbortController | null = null
let recording = false
let scrubbing = false
let scrubWasPlaying = false
let toastTimer = 0
let hideTimer = 0
let currentLibraryFolder = ROOT_FOLDER_ID
let libraryMoveOptions: Array<{ id: string; label: string }> = []

{
  const resolved = serverFieldValue()
  serverInput.value = resolved
  serverInput.placeholder = resolved
  const saved = (localStorage.getItem('pianosmith.server') || '').trim().replace(/\/$/, '')
  if (saved !== resolved) localStorage.setItem('pianosmith.server', resolved)
}
const namesOn = localStorage.getItem('pianosmith.names') === '1'
viz.setShowNames(namesOn)
namesBtn.setAttribute('aria-pressed', namesOn ? 'true' : 'false')
const handsOn = localStorage.getItem('pianosmith.hands') !== '0'
viz.setShowHands(handsOn)
handsBtn.setAttribute('aria-pressed', handsOn ? 'true' : 'false')
const zoomOn = localStorage.getItem('pianosmith.zoom') === '1'
viz.setZoom(zoomOn)
zoomBtn.setAttribute('aria-pressed', zoomOn ? 'true' : 'false')

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(t('missingElement', { id }))
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
  toast(error instanceof Error ? error.message : t('somethingWrong'))
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

function canSeekTransport() {
  return Boolean(notes && player && player.duration > 0 && statusEl.hidden && !recording && gate.hidden)
}

function currentSeekStep(big = false) {
  if (!big) return seekStep
  const index = SEEK_STEPS.indexOf(seekStep)
  return SEEK_STEPS[Math.min(SEEK_STEPS.length - 1, index + 1)] ?? seekStep
}

function syncSeekControls() {
  const label = `${seekStep}s`
  seekStepBtn.textContent = label
  seekBackBtn.textContent = `−${label}`
  seekForwardBtn.textContent = `+${label}`
  seekBackBtn.setAttribute('aria-label', t('seekBackAria', { n: seekStep }))
  seekForwardBtn.setAttribute('aria-label', t('seekForwardAria', { n: seekStep }))
  seekStepBtn.setAttribute('aria-label', t('seekStepAria', { n: seekStep }))
}

function setSeekStep(next: number) {
  seekStep = SEEK_STEPS.includes(next) ? next : 2
  localStorage.setItem('pianosmith.seekStep', String(seekStep))
  syncSeekControls()
}

function scrubToFraction(fraction: number) {
  if (!player || !player.duration) return
  void player.seek(Math.max(0, Math.min(1, fraction)) * player.duration)
}

function seekTransport(delta: number) {
  if (!canSeekTransport() || !player) return
  poke()
  void player.seekBy(delta)
}

function endScrub(resume: boolean) {
  scrubbing = false
  if (resume && scrubWasPlaying && player) void player.play()
  scrubWasPlaying = false
}

function syncUi() {
  const hasSong = Boolean(notes && player)
  topbar.hidden = !hasSong
  titleEl.textContent = songTitle
  const time = player?.currentTime ?? 0
  const duration = player?.duration ?? 0
  clock.textContent = `${fmt(time)} / ${fmt(duration)}`
  if (!scrubbing && duration > 0) scrub.value = String(Math.round((time / duration) * 1000))
  playBtn.textContent = player?.playing ? t('pause') : t('play')
  speedBtn.textContent = `${player?.rate ?? 1}×`
  if (recording) topbar.classList.add('hidden')
  else if (!player?.playing) topbar.classList.remove('hidden')
  const busy = !statusEl.hidden || recording
  centerPlay.hidden = !hasSong || Boolean(player?.playing) || !gate.hidden || busy
  playBtn.disabled = !hasSong || busy
  const canSeek = canSeekTransport()
  seekBackBtn.disabled = !canSeek
  seekForwardBtn.disabled = !canSeek
  seekStepBtn.disabled = busy
  settingsOpenBtn.disabled = !hasSong || busy
  midiBtn.disabled = !hasSong || busy
  sheetBtn.disabled = !hasSong || busy
  videoBtn.disabled = !hasSong || busy || !canRecord()
  speedBtn.disabled = !hasSong || busy
  namesBtn.disabled = !hasSong || busy
  handsBtn.disabled = !hasSong || busy
  zoomBtn.disabled = !hasSong || busy
  scrub.disabled = !hasSong || busy
  syncGateDismiss()
  if (player?.playing) poke()
}

async function startSong(title: string, nextNotes: NoteEvent[], buffer: AudioBuffer, alive: () => boolean) {
  if (!alive()) return
  if (nextNotes.length === 0) throw new Error(t('noPianoNotes'))
  const transport = ensurePlayer()
  notes = nextNotes
  songTitle = title
  transport.pause()
  transport.buffer = buffer
  await transport.setRate(1)
  viz.setTitle(title)
  viz.setNotes(nextNotes)
  gate.hidden = true
  syncGateDismiss()
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
  const kind = item.kind === 'midi' ? t('kindMidi') : t('kindAudio')
  const duration = formatDuration(item.duration)
  return duration ? `${kind} · ${duration}` : kind
}

async function refreshLibraryButton() {
  try {
    const count = await countLibrarySongs()
    libraryOpenBtn.textContent = count > 0 ? t('savedSongsCount', { n: count }) : t('savedSongs')
  } catch (error) {
    console.error(error)
    libraryOpenBtn.textContent = t('savedSongs')
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
  root.textContent = t('savedSongs')
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
    move.setAttribute('aria-label', t('moveSong', { title: options.title }))
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
  remove.setAttribute('aria-label', options.kind === 'folder' ? t('deleteFolder', { title: options.title }) : t('removeSong', { title: options.title }))
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
        meta: t('folder'),
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
    toast(error instanceof Error ? error.message : t('playlistUnavailable'))
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
    setStatus(t('openingSaved'), null)
    const song = await getLibrarySong(id)
    if (!song) throw new Error(t('songNotFound'))
    if (!job.alive()) return
    const next = prepareNotes(song.notes)
    if (song.kind === 'midi') {
      setStatus(t('renderingPiano'), null)
      const buffer = await renderPiano(next)
      await startSong(song.title, next, buffer, job.alive)
      return
    }
    setStatus(t('loadingAudio'), 0.08)
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
    toast(error instanceof Error ? error.message : t('removeSongFail'))
  }
}

async function loadFile(file: File) {
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  const source = fileSourceKey(file)
  try {
    if (isMidiFile(file)) {
      setStatus(t('readingMidi'), null)
      const bytes = await file.arrayBuffer()
      const parsed = notesFromMidi(bytes)
      const next = prepareNotes(parsed.notes)
      if (!job.alive()) return
      setStatus(t('renderingPiano'), null)
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
    if (file.size > 45 * 1024 * 1024) throw new Error(t('fileTooBig'))
    setStatus(t('loadingAudio'), 0.04)
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
    toast(t('pasteLink'))
    return
  }
  const job = beginJob()
  const transport = ensurePlayer()
  await transport.resume()
  const source = linkSourceKey(url)
  try {
    const fileSource =
      detectLink(url) === 'audio' ||
      /^(?:MIDI|MP3|WAV|FLAC|M4A|AAC|OGG|OPUS|OGA|WEBM|AIF|AIFF|WMA|ALAC|CAF)$/.test(sourceName)
    setStatus(fileSource ? t('downloadingFile') : t('downloadingFrom', { source: sourceName }), null)
    const downloaded = await fetchLink(url, job.signal)
    if (!job.alive()) return
    const bytes = await downloaded.blob.arrayBuffer()
    const midi = sourceName === 'MIDI' || downloaded.blob.type.includes('midi') || isMidiBytes(bytes)
    if (midi) {
      setStatus(t('readingMidi'), null)
      const parsed = notesFromMidi(bytes)
      const next = prepareNotes(parsed.notes)
      if (!job.alive()) return
      setStatus(t('renderingPiano'), null)
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
    if (bytes.byteLength > 45 * 1024 * 1024) throw new Error(t('fileTooBig'))
    setStatus(t('loadingAudio'), 0.05)
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
    setStatus(t('preparingDemo'), null)
    const next = prepareNotes(demoNotes())
    const buffer = await renderPiano(next)
    await startSong(t('demoTitle'), next, buffer, job.alive)
  } catch (error) {
    if (!job.alive()) return
    fail(error)
  }
}

async function exportSheet() {
  if (!notes || recording || !statusEl.hidden) return
  closeSettingsModal()
  sheetBtn.disabled = true
  setStatus(t('generatingSheet'), null)
  try {
    const { songToSheetPdf } = await import('./sheet')
    const blob = await songToSheetPdf(notes, songTitle)
    download(blob, `${safeName(songTitle)}.pdf`)
    toast(t('sheetReady'))
  } catch (error) {
    fail(error)
  } finally {
    hideStatus()
    syncUi()
    poke()
  }
}

async function exportVideo() {
  if (!player || !notes || recording) return
  if (!canRecord()) {
    toast(t('noVideoRecord'))
    return
  }
  closeSettingsModal()
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

function canDismissGate() {
  return Boolean(notes && player && statusEl.hidden && !recording)
}

function syncGateDismiss() {
  const dismissible = canDismissGate() && !gate.hidden
  gate.classList.toggle('dismissible', dismissible)
  gateCloseBtn.hidden = !dismissible
}

function hideGate() {
  if (!canDismissGate()) return
  gate.hidden = true
  syncGateDismiss()
  syncUi()
  poke()
}

function showLibrary() {
  closeSettingsModal()
  player?.pause()
  gate.hidden = false
  topbar.classList.remove('hidden')
  syncGateDismiss()
  syncUi()
  void refreshLibraryButton()
}

libraryOpenBtn.setAttribute('aria-expanded', 'false')
settingsOpenBtn.setAttribute('aria-expanded', 'false')
libraryOpenBtn.addEventListener('click', () => {
  void openLibraryModal()
})

libraryModal.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target === libraryModal || target.classList.contains('modal-backdrop')) {
    closeLibraryModal()
  }
})

libraryModal.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest('[data-library]') as HTMLElement | null
  if (!target || !libraryModal.contains(target)) return
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
        toast(error instanceof Error ? error.message : t('deleteFolderFail'))
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
      toast(error instanceof Error ? error.message : t('moveSongFail'))
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
      toast(error instanceof Error ? error.message : t('createFolderFail'))
    })
})

function openSettingsModal() {
  if (!notes || recording || !statusEl.hidden) return
  settingsModal.hidden = false
  settingsOpenBtn.setAttribute('aria-expanded', 'true')
  poke()
  queueMicrotask(ensureTvFocus)
}

function closeSettingsModal() {
  settingsModal.hidden = true
  settingsOpenBtn.setAttribute('aria-expanded', 'false')
  poke()
}

function dismissOverlays(event?: KeyboardEvent) {
  if (!libraryModal.hidden) {
    event?.preventDefault()
    if (!libraryFolderForm.hidden) {
      hideFolderForm()
      return true
    }
    closeLibraryModal()
    return true
  }
  if (!settingsModal.hidden) {
    event?.preventDefault()
    closeSettingsModal()
    return true
  }
  if (!gate.hidden && canDismissGate()) {
    event?.preventDefault()
    hideGate()
    return true
  }
  return false
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  dismissOverlays(event)
})

gate.addEventListener('pointerdown', (event) => {
  if (event.target !== gate || !canDismissGate()) return
  hideGate()
})

gateCloseBtn.addEventListener('click', (event) => {
  event.preventDefault()
  hideGate()
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
seekBackBtn.addEventListener('click', () => seekTransport(-seekStep))
seekForwardBtn.addEventListener('click', () => seekTransport(seekStep))
seekStepBtn.addEventListener('click', () => {
  const index = SEEK_STEPS.indexOf(seekStep)
  setSeekStep(SEEK_STEPS[(index + 1) % SEEK_STEPS.length] ?? 2)
  poke()
})

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

settingsOpenBtn.addEventListener('click', () => {
  openSettingsModal()
})

settingsCloseBtn.addEventListener('click', () => {
  closeSettingsModal()
})

settingsModal.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target === settingsModal || target.classList.contains('modal-backdrop')) closeSettingsModal()
})

settingsModal.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  if (target?.dataset.settings === 'close') closeSettingsModal()
})

speedBtn.addEventListener('click', () => {
  if (!player) return
  const index = RATES.indexOf(player.rate)
  const next = RATES[(index + 1) % RATES.length] ?? 1
  void player.setRate(next)
  syncUi()
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

zoomBtn.addEventListener('click', () => {
  const next = zoomBtn.getAttribute('aria-pressed') !== 'true'
  zoomBtn.setAttribute('aria-pressed', next ? 'true' : 'false')
  viz.setZoom(next)
  localStorage.setItem('pianosmith.zoom', next ? '1' : '0')
})

midiBtn.addEventListener('click', () => {
  if (!notes) return
  download(songToMidiBlob(notes, songTitle), `${safeName(songTitle)}.mid`)
})

sheetBtn.addEventListener('click', () => {
  void exportSheet()
})

videoBtn.addEventListener('click', () => {
  void exportVideo()
})

scrub.addEventListener('pointerdown', () => {
  scrubbing = true
  poke()
  if (player?.playing) {
    scrubWasPlaying = true
    player.pause()
  } else {
    scrubWasPlaying = false
  }
})
scrub.addEventListener('pointerup', () => endScrub(true))
scrub.addEventListener('pointercancel', () => endScrub(true))
scrub.addEventListener('input', () => {
  scrubToFraction(Number(scrub.value) / 1000)
})
scrub.addEventListener('change', () => {
  scrubToFraction(Number(scrub.value) / 1000)
})

serverInput.addEventListener('change', () => {
  const next = serverInput.value.trim().replace(/\/$/, '') || serverFieldValue()
  serverInput.value = next
  localStorage.setItem('pianosmith.server', next)
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

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (target as HTMLInputElement).type
  return type !== 'range'
}

function isTizenTv() {
  return typeof (window as Window & { tizen?: unknown }).tizen !== 'undefined'
}

function isSmartTvUi() {
  return (
    isTizenTv() ||
    document.documentElement.classList.contains('is-tv') ||
    /Tizen|SMART-TV|SmartTV|Samsung/i.test(navigator.userAgent)
  )
}

function isBackKey(event: KeyboardEvent) {
  const key = event.key
  const code = event.keyCode
  return (
    key === 'Back' ||
    key === 'XF86Back' ||
    key === 'GoBack' ||
    key === 'BrowserBack' ||
    key === 'Escape' ||
    code === 10009 ||
    code === 461 ||
    code === 27
  )
}

function isPlayPauseKey(event: KeyboardEvent) {
  const key = event.key
  const code = event.keyCode
  return (
    key === ' ' ||
    key === 'MediaPlayPause' ||
    key === 'XF86AudioPlay' ||
    key === 'XF86AudioPause' ||
    key === 'MediaPlay' ||
    key === 'MediaPause' ||
    code === 32 ||
    code === 10252 || // MediaPlayPause
    code === 415 || // MediaPlay
    code === 19 // MediaPause
  )
}

function seekDeltaFromKey(event: KeyboardEvent): number | null {
  const key = event.key
  const code = event.code
  const keyCode = event.keyCode
  const left =
    key === 'ArrowLeft' ||
    key === 'Left' ||
    code === 'ArrowLeft' ||
    keyCode === 37 ||
    key === 'MediaTrackPrevious' ||
    key === 'MediaRewind' ||
    key === 'XF86AudioRewind' ||
    key === 'XF86Previous' ||
    keyCode === 412 ||
    keyCode === 10232 ||
    keyCode === 177
  const right =
    key === 'ArrowRight' ||
    key === 'Right' ||
    code === 'ArrowRight' ||
    keyCode === 39 ||
    key === 'MediaTrackNext' ||
    key === 'MediaFastForward' ||
    key === 'XF86AudioForward' ||
    key === 'XF86Next' ||
    keyCode === 417 ||
    keyCode === 10233 ||
    keyCode === 176
  if (!left && !right) return null
  const step = currentSeekStep(event.shiftKey)
  return left ? -step : step
}

function isVisibleFocusable(node: HTMLElement) {
  if (node.hasAttribute('disabled') || (node as HTMLButtonElement).disabled) return false
  if (node.closest('[hidden]')) return false
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = node.getBoundingClientRect()
  return rect.width > 2 && rect.height > 2
}

/** Controls the TV remote can land on in the current overlay / top bar. */
function tvFocusables(): HTMLElement[] {
  const roots: HTMLElement[] = []
  if (!libraryModal.hidden) roots.push(libraryModal)
  else if (!settingsModal.hidden) roots.push(settingsModal)
  else if (!statusEl.hidden) roots.push(statusEl)
  else if (!gate.hidden) roots.push(gate)
  else if (!topbar.hidden) roots.push(topbar)
  if (!centerPlay.hidden) roots.push(centerPlay)

  const nodes = roots.flatMap((root) =>
    [...root.querySelectorAll<HTMLElement>('button, a[href], input, summary, select, [tabindex]:not([tabindex="-1"])')],
  )
  return nodes.filter((node) => {
    if (!isVisibleFocusable(node)) return false
    if (node.tagName === 'INPUT') {
      const type = (node as HTMLInputElement).type
      // Skip file pickers on TV; keep text/url/range reachable.
      if (type === 'file') return false
    }
    return true
  })
}

function focusTvEl(node: HTMLElement | null | undefined) {
  if (!node) return
  try {
    node.focus()
  } catch {
    /* ignore */
  }
}

function moveTvFocus(dx: number, dy: number) {
  const items = tvFocusables()
  if (!items.length) return
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const current = active && items.includes(active) ? active : null
  if (!current) {
    focusTvEl(items[0])
    return
  }

  const cur = current.getBoundingClientRect()
  const cx = cur.left + cur.width / 2
  const cy = cur.top + cur.height / 2
  let best: HTMLElement | null = null
  let bestScore = Infinity

  for (const item of items) {
    if (item === current) continue
    const box = item.getBoundingClientRect()
    const ix = box.left + box.width / 2
    const iy = box.top + box.height / 2
    const ox = ix - cx
    const oy = iy - cy
    if (dx !== 0 && Math.sign(ox) !== dx) continue
    if (dy !== 0 && Math.sign(oy) !== dy) continue
    if (dx !== 0 && Math.abs(ox) < 4) continue
    if (dy !== 0 && Math.abs(oy) < 4) continue
    const primary = dx !== 0 ? Math.abs(ox) : Math.abs(oy)
    const secondary = dx !== 0 ? Math.abs(oy) : Math.abs(ox)
    const score = primary * 1000 + secondary
    if (score < bestScore) {
      bestScore = score
      best = item
    }
  }

  if (best) focusTvEl(best)
  else if (dx !== 0) {
    const index = items.indexOf(current)
    focusTvEl(items[(index + dx + items.length) % items.length])
  }
}

function activateTvFocus() {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return
  if (el.tagName === 'SUMMARY') {
    const details = el.parentElement
    if (details instanceof HTMLDetailsElement) details.open = !details.open
    return
  }
  if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
    el.click()
  }
}

function exitTizenApp() {
  try {
    const tizen = (window as Window & {
      tizen?: { application?: { getCurrentApplication?: () => { exit: () => void } } }
    }).tizen
    tizen?.application?.getCurrentApplication?.().exit()
  } catch {
    /* ignore */
  }
}

function ensureTvFocus() {
  if (!isSmartTvUi()) return
  const active = document.activeElement
  if (active instanceof HTMLElement && tvFocusables().includes(active)) return
  focusTvEl(tvFocusables()[0] ?? document.body)
}

window.addEventListener('keydown', (event) => {
  poke()
  if (recording) return

  // Escape is also handled above for overlays; keep a single path for TV Back.
  if (isBackKey(event)) {
    if (dismissOverlays(event)) return
    if (gate.hidden && notes) {
      event.preventDefault()
      showLibrary()
      queueMicrotask(ensureTvFocus)
      return
    }
    // Home screen of the app: leave the widget.
    if (!gate.hidden && !canDismissGate()) {
      event.preventDefault()
      exitTizenApp()
    }
    return
  }

  if (isTextEntryTarget(event.target)) return

  const key = event.key
  const code = event.keyCode
  const playing = gate.hidden && Boolean(notes)

  // D-pad: navigate UI whenever an overlay/menu is open; while playing, Up/Down move the top bar.
  if (key === 'ArrowUp' || code === 38) {
    event.preventDefault()
    moveTvFocus(0, -1)
    return
  }
  if (key === 'ArrowDown' || code === 40) {
    event.preventDefault()
    moveTvFocus(0, 1)
    return
  }

  if (!playing) {
    if (key === 'ArrowLeft' || code === 37) {
      event.preventDefault()
      moveTvFocus(-1, 0)
      return
    }
    if (key === 'ArrowRight' || code === 39) {
      event.preventDefault()
      moveTvFocus(1, 0)
      return
    }
    if (key === 'Enter' || code === 13) {
      event.preventDefault()
      activateTvFocus()
      return
    }
    return
  }

  if (key === 'Enter' || code === 13) {
    const active = document.activeElement
    if (active instanceof HTMLElement && tvFocusables().includes(active) && active !== document.body) {
      event.preventDefault()
      activateTvFocus()
      return
    }
    event.preventDefault()
    void ensurePlayer().toggle()
    return
  }

  if (isPlayPauseKey(event)) {
    event.preventDefault()
    void ensurePlayer().toggle()
    return
  }

  const seekDelta = seekDeltaFromKey(event)
  if (seekDelta != null) {
    if (!canSeekTransport()) return
    event.preventDefault()
    event.stopPropagation()
    seekTransport(seekDelta)
    return
  }
  if (!canSeekTransport()) return
  if (event.key === 'Home') {
    event.preventDefault()
    if (player) void player.seek(0)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    if (player && player.duration) void player.seek(Math.max(0, player.duration - 0.05))
  }
})

window.addEventListener('resize', fit)

/**
 * Register only optional media keys. Arrows, Enter and Back are mandatory on Tizen
 * and must NOT be passed to registerKeyBatch — that invalidates the whole batch.
 */
function registerRemote() {
  if (isSmartTvUi()) document.documentElement.classList.add('is-tv')

  const tv = (window as Window & {
    tizen?: {
      tvinputdevice?: {
        registerKey?: (key: string) => void
        registerKeyBatch?: (
          keys: string[],
          successCallback?: () => void,
          errorCallback?: (error: unknown) => void,
        ) => void
      }
    }
  }).tizen

  const keys = [
    'MediaPlay',
    'MediaPause',
    'MediaPlayPause',
    'MediaStop',
    'MediaRewind',
    'MediaFastForward',
    'MediaTrackPrevious',
    'MediaTrackNext',
  ]

  const registerOne = (key: string) => {
    try {
      tv?.tvinputdevice?.registerKey?.(key)
    } catch {
      /* unsupported on this TV */
    }
  }

  try {
    if (tv?.tvinputdevice?.registerKeyBatch) {
      tv.tvinputdevice.registerKeyBatch(
        keys,
        () => undefined,
        () => {
          for (const key of keys) registerOne(key)
        },
      )
    } else {
      for (const key of keys) registerOne(key)
    }
  } catch {
    for (const key of keys) registerOne(key)
  }

  if (isSmartTvUi()) {
    document.body.setAttribute('tabindex', '-1')
    queueMicrotask(() => {
      try {
        document.body.focus()
      } catch {
        /* ignore */
      }
      ensureTvFocus()
    })
  }
}

async function refreshLinkServer() {
  const base = serverBase()
  const ok = await linkServerAvailable()
  if (ok) {
    hint.textContent = base ? t('linksVia', { base }) : t('linksReady')
    return
  }
  hint.textContent = base ? t('serverUnreachable') : t('linksNeedServer')
}

function showDetectedLink() {
  const name = linkSourceName(ytInput.value)
  const label = document.getElementById('link-kind')
  if (!label) return
  label.textContent = name ? t('recognized', { name }) : ''
}

ytInput.addEventListener('input', showDetectedLink)

fit()
syncSeekControls()
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
