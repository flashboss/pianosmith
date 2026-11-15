import { t } from './i18n'
export type LinkKind = 'archive' | 'spotify' | 'audio' | 'web' | 'youtube'

const AUDIO_EXT = /\.(mp3|wav|wave|flac|m4a|aac|ogg|opus|oga|webm|aif|aiff|wma|alac|caf|mid|midi)(?=$|[?#])/i

const KNOWN_HOSTS: Array<[RegExp, string]> = [
  [/(?:^|\.)soundcloud\.com$|^on\.soundcloud\.com$/, 'SoundCloud'],
  [/(?:^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/^music\.apple\.com$|^itunes\.apple\.com$/, 'Apple Music'],
  [/(?:^|\.)deezer\.com$/, 'Deezer'],
  [/(?:^|\.)tidal\.com$/, 'Tidal'],
  [/^music\.amazon\./, 'Amazon Music'],
  [/(?:^|\.)mixcloud\.com$/, 'Mixcloud'],
  [/(?:^|\.)audiomack\.com$/, 'Audiomack'],
  [/(?:^|\.)vimeo\.com$/, 'Vimeo'],
  [/(?:^|\.)dropbox\.com$|(?:^|\.)dropboxusercontent\.com$/, 'Dropbox'],
  [/^drive\.google\.com$/, 'Google Drive'],
]

function hostOf(input: string): string | null {
  try {
    return new URL(input.trim()).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function detectLink(input: string): LinkKind | null {
  const value = input.trim()
  if (!value) return null
  if (/^spotify:(track|album|playlist|episode):[A-Za-z0-9]{22}$/.test(value)) return 'spotify'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'archive.org') return 'archive'
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    return 'youtube'
  }
  if (host === 'open.spotify.com' || host === 'play.spotify.com' || host === 'spotify.link' || host === 'spoti.fi') {
    return 'spotify'
  }
  if (AUDIO_EXT.test(`${url.pathname}${url.search}`)) return 'audio'
  return 'web'
}

export function linkSourceName(input: string): string {
  const kind = detectLink(input)
  if (!kind) return ''
  if (kind === 'archive') return 'Internet Archive'
  if (kind === 'youtube') return 'YouTube'
  if (kind === 'spotify') return 'Spotify'
  if (kind === 'audio') {
    const match = input.trim().match(AUDIO_EXT)
    const ext = match?.[1]?.toLowerCase()
    if (!ext) return t('audioFile')
    if (ext === 'mid' || ext === 'midi') return 'MIDI'
    if (ext === 'wave') return 'WAV'
    return ext.toUpperCase()
  }
  const host = hostOf(input)
  if (!host) return t('webLink')
  for (const [pattern, label] of KNOWN_HOSTS) {
    if (pattern.test(host)) return label
  }
  return host
}

/** Link/search API host when the UI is on static GitHub Pages (no Node server). */
const FALLBACK_SERVER = 'https://pianosmith-40961844406.europe-west1.run.app'

function isStaticPagesHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, '').toLowerCase()
  return host === 'pianosmith.vige.it' || host.endsWith('.github.io')
}

export function defaultServerOrigin(): string {
  try {
    const { hostname, origin } = window.location
    // Pages serves only the SPA under /app/; /api/* still needs Cloud Run (or another Node host).
    if (isStaticPagesHost(hostname)) return FALLBACK_SERVER
    const cleaned = origin.replace(/\/$/, '')
    if (cleaned && cleaned !== 'null' && /^https?:\/\//i.test(cleaned)) return cleaned
  } catch {
    /* ignore */
  }
  return FALLBACK_SERVER
}

function isLoopbackHost(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])\b/i.test(value.trim())
  }
}

/** API base: saved Server field, else the URL used to open the app. */
export function serverBase(): string {
  const saved = (localStorage.getItem('pianosmith.server') || '').trim().replace(/\/$/, '')
  if (!saved) return defaultServerOrigin()
  if (isLoopbackHost(saved) && !isLoopbackHost(defaultServerOrigin())) return defaultServerOrigin()
  return saved
}

/** Value to show in the Server field (saved or current page origin). */
export function serverFieldValue(): string {
  return serverBase()
}

export async function fetchLink(input: string, signal?: AbortSignal): Promise<{ blob: Blob; title: string }> {
  const base = serverBase()
  const response = await fetch(`${base}/api/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: input.trim() }),
    signal,
  })
  if (!response.ok) {
    let message = t('downloadFailed')
    try {
      const body = (await response.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      /* keep default */
    }
    throw new Error(message)
  }
  const encoded = response.headers.get('X-Song-Title') || ''
  let title = t('kindAudio')
  try {
    title = decodeURIComponent(encoded) || title
  } catch {
    title = encoded || title
  }
  return { blob: await response.blob(), title }
}

export async function linkServerAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    const response = await fetch(`${serverBase()}/api/health`, { signal: controller.signal }).finally(() => {
      window.clearTimeout(timer)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: boolean; archive?: boolean; ytdlp?: boolean }
    if (typeof body.archive === 'boolean') return body.archive
    if (typeof body.ytdlp === 'boolean') return body.ytdlp
    return Boolean(body.ok)
  } catch {
    return false
  }
}

export type SearchVideo = {
  id: string
  title: string
  channel: string
  duration: number
  url: string
  thumbnail: string
}

export async function searchVideos(query: string, signal?: AbortSignal): Promise<SearchVideo[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const response = await fetch(`${serverBase()}/api/search?q=${encodeURIComponent(q)}`, { signal })
  if (!response.ok) {
    let message = t('searchFailed')
    try {
      const body = (await response.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      /* keep default */
    }
    throw new Error(message)
  }
  const body = (await response.json()) as { results?: SearchVideo[] }
  return Array.isArray(body.results) ? body.results : []
}
