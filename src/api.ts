export type LinkKind = 'youtube' | 'spotify' | 'audio' | 'web'

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
  [/(?:^|\.)tiktok\.com$/, 'TikTok'],
  [/(?:^|\.)instagram\.com$/, 'Instagram'],
  [/(?:^|\.)(?:facebook|fb)\.com$|^fb\.watch$/, 'Facebook'],
  [/(?:^|\.)twitch\.tv$/, 'Twitch'],
  [/(?:^|\.)dailymotion\.com$/, 'Dailymotion'],
  [/(?:^|\.)archive\.org$/, 'Internet Archive'],
  [/(?:^|\.)dropbox\.com$|(?:^|\.)dropboxusercontent\.com$/, 'Dropbox'],
  [/^drive\.google\.com$/, 'Google Drive'],
  [/(?:^|\.)nicovideo\.jp$/, 'Niconico'],
  [/(?:^|\.)bilibili\.com$/, 'Bilibili'],
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
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return 'youtube'
  if (/^spotify:(track|album|playlist|episode):[A-Za-z0-9]{22}$/.test(value)) return 'spotify'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\./, '')
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
  if (kind === 'youtube') return 'YouTube'
  if (kind === 'spotify') return 'Spotify'
  if (kind === 'audio') {
    const match = input.trim().match(AUDIO_EXT)
    const ext = match?.[1]?.toLowerCase()
    if (!ext) return 'file audio'
    if (ext === 'mid' || ext === 'midi') return 'MIDI'
    if (ext === 'wave') return 'WAV'
    return ext.toUpperCase()
  }
  const host = hostOf(input)
  if (!host) return 'link web'
  for (const [pattern, label] of KNOWN_HOSTS) {
    if (pattern.test(host)) return label
  }
  return host
}

export function serverBase(): string {
  return (localStorage.getItem('pianosmith.server') || '').replace(/\/$/, '')
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
    let message = 'Download non riuscito'
    try {
      const body = (await response.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      /* keep default */
    }
    throw new Error(message)
  }
  const encoded = response.headers.get('X-Song-Title') || ''
  let title = 'Audio'
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
    const body = (await response.json()) as { ytdlp?: boolean }
    return Boolean(body.ytdlp)
  } catch {
    return false
  }
}
