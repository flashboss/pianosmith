import { spawn } from 'node:child_process'
import { existsSync, createReadStream, statSync } from 'node:fs'
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

async function searchYouTube(query, targetSeconds) {
  const { stdout } = await run(
    'yt-dlp',
    ['--flat-playlist', '--no-warnings', '--print', '%(id)s\t%(duration)s\t%(title)s', `ytsearch8:${query}`],
    root,
  )
  const rows = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, duration, ...rest] = line.split('\t')
      return { id, duration: Number(duration), title: rest.join('\t') }
    })
    .filter((row) => ID.test(row.id))
  if (rows.length === 0) throw new Error('Nessun audio trovato per questo brano')
  let best = rows[0]
  let bestScore = Infinity
  for (const row of rows) {
    if (!Number.isFinite(row.duration) || row.duration <= 0) continue
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

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: commandEnv() })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Download scaduto'))
    }, 180000)
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

async function downloadYouTube(url, titleOverride) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pianosmith-'))
  try {
    const args = [
        '--playlist-items',
        '1',
        '--no-simulate',
        '--no-warnings',
        '--no-progress',
        '--restrict-filenames',
        '--match-filter',
        'duration < 600',
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
  if (error?.code === 'ENOENT' || text.includes('ENOENT') || /yt-dlp/i.test(text) && /not found/i.test(text)) {
    return 'yt-dlp non è installato su questo computer'
  }
  if (/ffmpeg|ffprobe/i.test(text)) return 'ffmpeg non è installato su questo computer'
  if (/does not pass|filtered|duration/i.test(text)) return 'Il video supera i 10 minuti'
  if (/private|unavailable|confirm your age|sign in/i.test(text)) return 'Video non disponibile'
  if (text === 'Download scaduto') return 'Download scaduto. Riprova.'
  if (/unsupported url|no suitable extractor|unable to extract|not a valid url/i.test(text)) {
    return 'Questo link non contiene un audio che posso scaricare'
  }
  if (/Spotify|brano|Nessun audio|Link non valido|Il file ha risposto|Audio troppo grande|Audio scaricato vuoto/i.test(text)) return text
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
      sendJson(res, 200, { ok: true, ytdlp: await ytdlpAvailable() })
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
