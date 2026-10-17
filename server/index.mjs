import { spawn } from 'node:child_process'
import { existsSync, createReadStream, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prod = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT || 5173)
const ID = /^[a-zA-Z0-9_-]{11}$/

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.alac': 'audio/mp4',
  '.caf': 'audio/x-caf',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
}

const AUDIO_EXT = new Set(Object.keys(AUDIO_TYPES))

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.mid': 'audio/midi',
  '.woff2': 'font/woff2',
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Richiesta troppo grande'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/
const SPOTIFY_PATH = /^(?:\/intl-[a-z]{2})?\/(track|album|playlist|episode)\/([A-Za-z0-9]{22})(?:\/|$)/

function youtubeUrl(input) {
  const value = String(input || '').trim()
  if (ID.test(value)) return `https://www.youtube.com/watch?v=${value}`
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || ''
    return ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const watch = url.searchParams.get('v') || ''
    if (url.pathname === '/watch' && ID.test(watch)) return `https://www.youtube.com/watch?v=${watch}`
    const nested = url.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/)
    if (nested) return `https://www.youtube.com/watch?v=${nested[1]}`
  }
  return null
}

function spotifyTarget(input) {
  const value = String(input || '').trim()
  const uri = value.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]{22})$/)
  if (uri) return { kind: uri[1], id: uri[2] }
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'spotify.link' || host === 'spoti.fi') return { kind: 'short', url: url.toString() }
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null
  const match = url.pathname.match(SPOTIFY_PATH)
  if (!match || !SPOTIFY_ID.test(match[2])) return null
  return { kind: match[1], id: match[2] }
}

async function fetchText(target) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PianoSmith/1.0)',
        Accept: 'text/html,application/json',
      },
    })
    if (!response.ok) throw new Error(`Spotify ha risposto ${response.status}`)
    return { url: response.url, text: await response.text() }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Spotify non risponde')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function entityFromEmbed(html) {
  const marker = '<script id="__NEXT_DATA__"'
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('Metadati Spotify non disponibili')
  const jsonStart = html.indexOf('>', start) + 1
  const jsonEnd = html.indexOf('</script>', jsonStart)
  if (jsonEnd < 0) throw new Error('Metadati Spotify non disponibili')
  const data = JSON.parse(html.slice(jsonStart, jsonEnd))
  const entity = data?.props?.pageProps?.state?.data?.entity
  if (!entity) throw new Error('Brano Spotify non trovato')
  return entity
}

function songFromEntity(entity) {
  if (entity.type === 'track' || entity.type === 'episode') {
    const artist = Array.isArray(entity.artists)
      ? entity.artists.map((item) => item.name).filter(Boolean).join(', ')
      : entity.subtitle || ''
    const title = entity.title || entity.name
    if (!title) throw new Error('Brano Spotify non trovato')
    return { title, artist, durationMs: Number(entity.duration) || 0 }
  }
  const tracks = Array.isArray(entity.trackList) ? entity.trackList : []
  const track = tracks.find((item) => item && item.title && item.isPlayable !== false)
  if (!track) throw new Error('Questo link Spotify non contiene un brano. Incolla il link del brano.')
  return {
    title: track.title,
    artist: track.subtitle || entity.subtitle || '',
    durationMs: Number(track.duration) || 0,
  }
}

async function resolveSpotify(input) {
  let target = spotifyTarget(input)
  if (!target) return null
  if (target.kind === 'short') {
    const followed = await fetchText(target.url)
    target = spotifyTarget(followed.url)
    if (!target || target.kind === 'short') throw new Error('Link Spotify non valido')
  }
  const page = await fetchText(`https://open.spotify.com/embed/${target.kind}/${target.id}`)
  return songFromEntity(entityFromEmbed(page.text))
}

function cleanQuery(text) {
  return text.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
}

function songLabel(song) {
  return song.artist ? `${song.artist} — ${song.title}` : song.title
}

async function listYouTubeSearch(query, limit = 8) {
  const capped = Math.min(Math.max(Number(limit) || 8, 1), 12)
  const { stdout } = await run(
    'yt-dlp',
    [
      '--flat-playlist',
      '--no-warnings',
      '--print',
      '%(id)s\t%(duration)s\t%(uploader)s\t%(title)s',
      `ytsearch${capped}:${query}`,
    ],
    root,
    45000,
  )
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, duration, uploader, ...rest] = line.split('\t')
      return {
        id,
        duration: Number(duration),
        channel: uploader || '',
        title: rest.join('\t'),
      }
    })
    .filter((row) => ID.test(row.id) && row.title)
    .map((row) => ({
      id: row.id,
      title: row.title,
      channel: row.channel,
      duration: Number.isFinite(row.duration) && row.duration > 0 ? row.duration : 0,
      url: `https://www.youtube.com/watch?v=${row.id}`,
      thumbnail: `https://i.ytimg.com/vi/${row.id}/mqdefault.jpg`,
    }))
}

async function searchYouTube(query, targetSeconds) {
  const rows = await listYouTubeSearch(query, 8)
  if (rows.length === 0) throw new Error('Nessun audio trovato per questo brano')
  let best = rows[0]
  let bestScore = Infinity
  for (const row of rows) {
    if (!row.duration) continue
    const score = Math.abs(row.duration - targetSeconds)
    if (score < bestScore) {
      bestScore = score
      best = row
    }
  }
  return best
}

function commandEnv() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((dir) => existsSync(dir))
  const current = process.env.PATH || ''
  const merged = [...extra, ...current.split(path.delimiter)].filter(Boolean)
  return { ...process.env, PATH: [...new Set(merged)].join(path.delimiter) }
}

function ffmpegDir() {
  for (const dir of commandEnv().PATH.split(path.delimiter)) {
    if (existsSync(path.join(dir, 'ffmpeg'))) return dir
  }
  return null
}

function run(cmd, args, cwd, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: commandEnv() })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(timeoutMs < 60000 ? 'Ricerca scaduta' : 'Download scaduto'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || `${cmd} uscito con codice ${code}`))
    })
  })
}

async function ytdlpAvailable() {
  try {
    await run('yt-dlp', ['--version'], root)
    return true
  } catch {
    return false
  }
}

let busy = false
let cookiesPath = null
let cookiesReady = null
let cookiesMeta = { source: null, bytes: 0, ok: false, error: null }

/**
 * Railway / UI env vars often flatten newlines or store literal \n / \t.
 * Netscape cookies need real newlines and tabs.
 */
function recoverNetscapeLine(line) {
  if (!line || line.includes('\t')) return line
  if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) return line
  const httpOnly = line.startsWith('#HttpOnly_')
  const body = httpOnly ? line.slice('#HttpOnly_'.length) : line
  const parts = body.trim().split(/\s+/)
  if (parts.length < 7 || !/[a-z0-9.-]+\.[a-z]{2,}/i.test(parts[0])) return line
  const rebuilt = `${parts[0]}\t${parts[1]}\t${parts[2]}\t${parts[3]}\t${parts[4]}\t${parts[5]}\t${parts.slice(6).join(' ')}`
  return httpOnly ? `#HttpOnly_${rebuilt}` : rebuilt
}

function normalizeCookiesText(raw) {
  let text = String(raw || '').replace(/^\uFEFF/, '').trim()
  if (!text) return ''
  // Escaped newlines/tabs when a multiline secret was pasted as one line
  text = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  text = text.split('\n').map(recoverNetscapeLine).join('\n')
  if (!/^(\s*#|$)/m.test(text) || !/# Netscape/i.test(text)) {
    text = `# Netscape HTTP Cookie File\n# PianoSmith\n${text}`
  }
  if (!text.endsWith('\n')) text += '\n'
  return text
}

function cookiesLookValid(text) {
  const lines = text.split('\n').filter((line) => {
    if (!line) return false
    if (line.startsWith('#HttpOnly_')) return true
    if (line.startsWith('#')) return false
    return true
  })
  if (lines.length === 0) return false
  return lines.some((line) => {
    const body = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line
    return body.includes('\t') && /youtube|google|googlevideo/i.test(body)
  })
}

/** Raw env paste without real tabs/newlines cannot be trusted — use Base64 instead. */
function envCookiesTrustworthy(raw) {
  return raw.includes('\t') || raw.includes('\\t') || (raw.includes('\n') && /youtube|google/i.test(raw))
}

function writeCookiesFile(raw, source) {
  const text = normalizeCookiesText(raw)
  if (!cookiesLookValid(text)) {
    throw new Error(
      `Cookie YouTube non validi (source=${source}). Elimina YTDLP_COOKIES, riesegui npm run cookies:export e imposta solo YTDLP_COOKIES_B64.`,
    )
  }
  cookiesPath = path.join(os.tmpdir(), 'pianosmith-yt-cookies.txt')
  writeFileSync(cookiesPath, text, 'utf8')
  cookiesMeta = { source, bytes: Buffer.byteLength(text), ok: true, error: null }
  return cookiesPath
}

/**
 * Resolve cookies for yt-dlp (first match wins):
 * YTDLP_COOKIES_B64 → YTDLP_COOKIES_FILE → YTDLP_COOKIES_URL → YTDLP_COOKIES
 * Base64 is preferred because Railway multiline Variables corrupt Netscape tabs.
 */
async function ensureYoutubeCookiesArgs() {
  if (cookiesReady) return cookiesReady
  cookiesReady = (async () => {
    try {
      const b64 = process.env.YTDLP_COOKIES_B64?.trim()
      if (b64) {
        const decoded = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')
        if (!/youtube|google|googlevideo/i.test(decoded)) {
          throw new Error(
            'YTDLP_COOKIES_B64 non decodifica un file cookie YouTube. Incolla il contenuto di yt-cookies.b64 (non il .txt).',
          )
        }
        return ['--cookies', writeCookiesFile(decoded, 'b64')]
      }
      if (process.env.YTDLP_COOKIES_FILE && existsSync(process.env.YTDLP_COOKIES_FILE)) {
        cookiesMeta = { source: 'file', bytes: 0, ok: true, error: null }
        return ['--cookies', process.env.YTDLP_COOKIES_FILE]
      }
      const url = process.env.YTDLP_COOKIES_URL?.trim()
      if (url) {
        const response = await fetch(url, { redirect: 'follow' })
        if (!response.ok) throw new Error(`Cookie URL HTTP ${response.status}`)
        const text = await response.text()
        if (text.trim().length < 20) throw new Error('Cookie URL returned an empty file')
        return ['--cookies', writeCookiesFile(text, 'url')]
      }
      const raw = process.env.YTDLP_COOKIES?.trim()
      if (raw) {
        if (!envCookiesTrustworthy(raw)) {
          throw new Error(
            'YTDLP_COOKIES è corrotto (Railway spezza TAB/newline). Eliminalo e usa YTDLP_COOKIES_B64 da npm run cookies:export.',
          )
        }
        return ['--cookies', writeCookiesFile(raw, 'env')]
      }
      cookiesMeta = { source: null, bytes: 0, ok: false, error: null }
      return []
    } catch (error) {
      cookiesMeta = {
        source: cookiesMeta.source,
        bytes: 0,
        ok: false,
        error: String(error?.message || error).slice(0, 220),
      }
      cookiesReady = null
      throw error
    }
  })()
  return cookiesReady
}

/** Optional HTTP(S) proxy so yt-dlp leaves from a residential IP instead of the cloud host. */
function youtubeProxyArgs() {
  const proxy = (process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
  return proxy ? ['--proxy', proxy] : []
}

async function downloadYouTube(url, titleOverride) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pianosmith-'))
  try {
    const args = [
      '--playlist-items',
      '1',
      '--no-simulate',
      '--no-progress',
      '--restrict-filenames',
      '--match-filter',
      'duration < 600',
      // Cloud hosts (Railway, etc.) are often blocked on the web client; android/ios
      // plus a JS runtime for YouTube challenges work more reliably.
      '--js-runtimes',
      'node',
      '--extractor-args',
      'youtube:player_client=android,ios,web',
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '5',
      '-o',
      'audio.%(ext)s',
      '--print',
      '%(title)s',
      ...(await ensureYoutubeCookiesArgs()),
      ...youtubeProxyArgs(),
    ]
    const ffmpeg = ffmpegDir()
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
    args.push(url)
    const { stdout } = await run('yt-dlp', args, dir)
    const printed = stdout.split('\n').map((line) => line.trim()).find(Boolean) || 'Audio'
    const title = titleOverride || printed
    const files = await readdir(dir)
    const audioName = files.find((name) => AUDIO_TYPES[path.extname(name).toLowerCase()])
    if (!audioName) throw new Error('Audio non trovato dopo il download')
    const filePath = path.join(dir, audioName)
    const data = await readFile(filePath)
    if (data.length < 1000) throw new Error('Audio scaricato vuoto')
    if (data.length > 45 * 1024 * 1024) throw new Error('Audio troppo grande')
    return {
      title: title.slice(0, 180),
      data,
      type: AUDIO_TYPES[path.extname(audioName).toLowerCase()] || 'application/octet-stream',
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function friendly(error) {
  const text = String(error?.message || error || '')
  if (error?.code === 'ENOENT' || text.includes('ENOENT') || (/yt-dlp/i.test(text) && /not found/i.test(text))) {
    return 'yt-dlp non è installato su questo computer'
  }
  if (/ffmpeg|ffprobe/i.test(text)) return 'ffmpeg non è installato su questo computer'
  if (/does not pass|filtered|duration/i.test(text)) return 'Il video supera i 10 minuti'
  if (/Cookie YouTube non validi|YTDLP_COOKIES|does not look like a Netscape/i.test(text)) {
    return text.includes('YTDLP_COOKIES_B64') || text.includes('yt-cookies.b64')
      ? text.slice(0, 240)
      : 'Cookie YouTube non validi su Railway. Elimina YTDLP_COOKIES, riesegui npm run cookies:export e imposta solo YTDLP_COOKIES_B64 (contenuto di yt-cookies.b64).'
  }
  if (/proxy|tunnel connection failed/i.test(text)) {
    return 'Proxy non raggiungibile. Controlla YTDLP_PROXY / HTTPS_PROXY.'
  }
  if (/sign in to confirm|not a bot|cookies? are (?:required|needed)|http error 403/i.test(text)) {
    return 'YouTube blocca i download da questo server (IP cloud). Imposta YTDLP_COOKIES_B64 (da npm run cookies:export), oppure YTDLP_PROXY, oppure usa un file audio locale.'
  }
  if (/private|unavailable|confirm your age|sign in/i.test(text)) return 'Video non disponibile'
  if (text === 'Download scaduto') return 'Download scaduto. Riprova.'
  if (/unsupported url|no suitable extractor|unable to extract|not a valid url/i.test(text)) {
    return 'Questo link non contiene un audio che posso scaricare'
  }
  if (/Spotify|brano|Nessun audio|Link non valido|Il file ha risposto|Audio troppo grande|Audio scaricato vuoto|Cookie URL/i.test(text)) {
    return text
  }
  // Surface a short yt-dlp hint without dumping full stderr to clients.
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) || ''
  if (line.length > 12 && line.length < 220 && !/node:|at |\/app\//i.test(line)) return line
  return 'Non sono riuscito a scaricare l’audio'
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number)
    if (parts.some((part) => part > 255)) return true
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  return false
}

function publicHttpUrl(input) {
  let url
  try {
    url = new URL(String(input || '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (isPrivateHost(url.hostname)) return null
  return url
}

function audioExtension(url) {
  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '')
  const ext = path.extname(name.split('?')[0]).toLowerCase()
  return AUDIO_EXT.has(ext) ? ext : ''
}

function filenameFrom(header, url) {
  const value = String(header || '')
  const encoded = value.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* keep looking */
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)
  if (plain) return plain[1].trim()
  return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'audio')
}

async function downloadDirect(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PianoSmith/1.0)',
        Accept: 'audio/*,video/*,application/octet-stream,*/*',
      },
    })
    let finalUrl
    try {
      finalUrl = new URL(response.url)
    } catch {
      throw new Error('Link non valido')
    }
    if ((finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') || isPrivateHost(finalUrl.hostname)) {
      throw new Error('Link non valido')
    }
    if (!response.ok) throw new Error(`Il file ha risposto ${response.status}`)
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (type.startsWith('text/') || type.includes('html') || type.includes('json')) {
      throw new Error('pagina')
    }
    const ext = audioExtension(finalUrl) || audioExtension(url)
    const playable = type.startsWith('audio/') || type.startsWith('video/') || type === 'application/ogg' || type === 'application/octet-stream' || Boolean(ext)
    if (!playable) throw new Error('pagina')
    const announced = Number(response.headers.get('content-length') || 0)
    if (announced > 45 * 1024 * 1024) throw new Error('Audio troppo grande')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 45 * 1024 * 1024) throw new Error('Audio troppo grande')
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (data.length < 32) throw new Error('Audio scaricato vuoto')
    const filename = filenameFrom(response.headers.get('content-disposition'), finalUrl)
    const fileExt = path.extname(filename).toLowerCase()
    const title = filename.replace(/\.[^.]+$/, '') || 'Audio'
    return {
      title: title.slice(0, 180),
      data,
      type: AUDIO_TYPES[fileExt] || AUDIO_TYPES[ext] || (type.startsWith('audio/') || type.startsWith('video/') ? type : 'application/octet-stream'),
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Download scaduto')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function downloadFromLink(input) {
  const youtube = youtubeUrl(input)
  if (youtube) return downloadYouTube(youtube)
  if (spotifyTarget(input)) {
    const song = await resolveSpotify(input)
    if (song.durationMs > 600000) throw new Error('Il brano supera i 10 minuti')
    const query = cleanQuery(`${song.artist} ${song.title}`)
    if (!query) throw new Error('Brano Spotify non trovato')
    const match = await searchYouTube(query, song.durationMs / 1000)
    return downloadYouTube(`https://www.youtube.com/watch?v=${match.id}`, songLabel(song))
  }
  const page = publicHttpUrl(input)
  if (!page) return null
  if (audioExtension(page)) {
    try {
      return await downloadDirect(page)
    } catch (error) {
      if (!/pagina/i.test(String(error?.message || ''))) throw error
    }
  }
  return downloadYouTube(page.toString())
}

function serveStatic(req, res) {
  const dist = path.join(root, 'dist')
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  let relative = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '')
  if (relative === '/' || relative === path.sep) relative = '/index.html'
  let filePath = path.join(dist, relative)
  if (!filePath.startsWith(dist)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(dist, 'index.html')
  }
  if (!existsSync(filePath)) {
    sendJson(res, 404, { message: 'Build mancante. Esegui npm run build.' })
    return
  }
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
  createReadStream(filePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    })
    res.end()
    return
  }
  try {
    if (url.pathname === '/api/health') {
      const ytdlp = await ytdlpAvailable()
      try {
        await ensureYoutubeCookiesArgs()
      } catch {
        /* cookiesMeta already set */
      }
      sendJson(res, 200, {
        ok: true,
        ytdlp,
        cookies: {
          source: cookiesMeta.source,
          bytes: cookiesMeta.bytes,
          ok: cookiesMeta.ok,
          error: cookiesMeta.error,
          proxy: Boolean((process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()),
        },
      })
      return
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const query = cleanQuery(url.searchParams.get('q') || '')
      if (query.length < 2) {
        sendJson(res, 400, { message: 'Scrivi almeno 2 caratteri' })
        return
      }
      if (!(await ytdlpAvailable())) {
        sendJson(res, 503, { message: 'yt-dlp non disponibile' })
        return
      }
      try {
        const results = await listYouTubeSearch(query, 8)
        sendJson(res, 200, { results })
      } catch (error) {
        console.error(error)
        sendJson(res, 502, { message: friendly(error) })
      }
      return
    }
    if ((url.pathname === '/api/link' || url.pathname === '/api/youtube') && req.method === 'POST') {
      if (busy) {
        sendJson(res, 429, { message: 'C’è già un download in corso' })
        return
      }
      const raw = await readBody(req)
      const body = JSON.parse(raw.toString('utf8') || '{}')
      if (!youtubeUrl(body.url) && !spotifyTarget(body.url) && !publicHttpUrl(body.url)) {
        sendJson(res, 400, { message: 'Incolla un link http o https' })
        return
      }
      busy = true
      try {
        const audio = await downloadFromLink(body.url)
        if (!audio) {
          sendJson(res, 400, { message: 'Incolla un link http o https' })
          return
        }
        res.writeHead(200, {
          'Content-Type': audio.type,
          'Content-Length': audio.data.length,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Song-Title',
          'X-Song-Title': encodeURIComponent(audio.title),
        })
        res.end(audio.data)
      } catch (error) {
        console.error(error)
        if (!res.headersSent) sendJson(res, 502, { message: friendly(error) })
      } finally {
        busy = false
      }
      return
    }
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { message: friendly(error) })
    return
  }

  if (prod) {
    serveStatic(req, res)
    return
  }
  vite.middlewares(req, res, () => {
    if (!res.headersSent) {
      res.writeHead(404)
      res.end()
    }
  })
})

let vite
if (!prod) {
  const { createServer } = await import('vite')
  vite = await createServer({
    root,
    server: { middlewareMode: true, host: true },
    appType: 'spa',
  })
}

server.listen(port, '0.0.0.0', () => {
  console.log(`PianoSmith  http://localhost:${port}`)
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) console.log(`             http://${entry.address}:${port}`)
    }
  }
})
