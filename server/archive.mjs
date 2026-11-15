/**
 * Internet Archive search + audio download (no cookies / yt-dlp).
 * https://archive.org/developers/
 */

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.wave', '.aif', '.aiff', '.wma'])
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
}

const FORMAT_RANK = [
  'VBR MP3',
  'MP3',
  '128Kbps MP3',
  '64Kbps MP3',
  'Ogg Vorbis',
  'Flac',
  'FLAC',
  'AIFF',
  'WAV',
  'Wave',
  'Apple Lossless',
  'MPEG4',
]

const MAX_BYTES = 45 * 1024 * 1024
const MAX_SECONDS = 600

export function archiveIdentifier(input) {
  const value = String(input || '').trim()
  if (!value) return null
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{1,100}$/.test(value) && !value.includes('://')) return value
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'archive.org' && host !== 'www.archive.org') return null
  const details = url.pathname.match(/^\/details\/([^/?#]+)/)
  if (details) return decodeURIComponent(details[1])
  const download = url.pathname.match(/^\/download\/([^/?#]+)/)
  if (download) return decodeURIComponent(download[1])
  const metadata = url.pathname.match(/^\/metadata\/([^/?#]+)/)
  if (metadata) return decodeURIComponent(metadata[1])
  return null
}

export function parseRuntime(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : 0
  const text = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

function cleanQuery(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

async function fetchJson(url, timeoutMs = 25000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'PianoSmith/1.0 (https://pianosmith.vige.it; archive.org client)',
        Accept: 'application/json',
      },
    })
    if (!response.ok) throw new Error(`Archive.org ha risposto ${response.status}`)
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Archive.org non risponde')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function listArchiveSearch(query, limit = 8) {
  const q = cleanQuery(query)
  if (q.length < 2) return []
  const capped = Math.min(Math.max(Number(limit) || 8, 1), 12)
  // Prefer title/creator phrase match; fetch extra rows then drop overlong items.
  const phrase = q.includes(' ') ? `"${q}"` : q
  const params = new URLSearchParams()
  params.set('q', `mediatype:(audio) AND (title:${phrase} OR creator:${phrase})`)
  for (const field of ['identifier', 'title', 'creator', 'runtime']) params.append('fl[]', field)
  params.append('sort[]', 'downloads desc')
  params.set('rows', String(Math.min(capped * 3, 24)))
  params.set('page', '1')
  params.set('output', 'json')
  const data = await fetchJson(`https://archive.org/advancedsearch.php?${params}`)
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : []
  return docs
    .map((doc) => {
      const id = String(doc.identifier || '').trim()
      if (!id) return null
      const title = String(doc.title || id).trim()
      const creator = Array.isArray(doc.creator) ? doc.creator.filter(Boolean).join(', ') : String(doc.creator || '')
      const duration = parseRuntime(doc.runtime)
      if (duration > MAX_SECONDS) return null
      return {
        id,
        title,
        channel: creator,
        duration,
        url: `https://archive.org/details/${encodeURIComponent(id)}`,
        thumbnail: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      }
    })
    .filter(Boolean)
    .slice(0, capped)
}

export async function searchArchive(query, targetSeconds) {
  const rows = await listArchiveSearch(query, 8)
  if (rows.length === 0) throw new Error('Nessun audio trovato su Internet Archive')
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return rows[0]
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

function fileExt(name) {
  const base = String(name || '').split('?')[0]
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

function pickAudioFile(files, preferTitle = '') {
  const needle = String(preferTitle || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const tokens = needle.split(/\s+/).filter((t) => t.length > 2)
  const candidates = (Array.isArray(files) ? files : [])
    .map((file) => {
      const name = String(file.name || '').trim()
      if (!name || name.endsWith('/')) return null
      const ext = fileExt(name)
      const format = String(file.format || '')
      const length = parseRuntime(file.length)
      const size = Number(file.size) || 0
      const source = String(file.source || '')
      if (source === 'metadata') return null
      const playable = AUDIO_EXT.has(ext) || /mp3|ogg|flac|wav|aiff|mpeg4|m4a|opus/i.test(format)
      if (!playable) return null
      if (length > MAX_SECONDS) return null
      if (size > MAX_BYTES) return null
      let rank = FORMAT_RANK.findIndex((label) => format.toLowerCase() === label.toLowerCase())
      if (rank < 0) rank = FORMAT_RANK.length + (AUDIO_EXT.has(ext) ? 0 : 10)
      const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      const hitScore = tokens.reduce((score, token) => score + (nameKey.includes(token) ? 1 : 0), 0)
      return { name, ext, format, length, size, rank, hitScore }
    })
    .filter(Boolean)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.hitScore - a.hitScore || a.rank - b.rank || a.size - b.size)
  return candidates[0]
}

export async function resolveArchiveAudio(identifier) {
  const id = String(identifier || '').trim()
  if (!id) throw new Error('Identificativo Archive.org non valido')
  const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`)
  const title =
    String(meta?.metadata?.title || meta?.metadata?.album || id).trim().slice(0, 180) || id
  const picked = pickAudioFile(meta?.files, title)
  if (!picked) throw new Error('Nessun file audio utilizzabile (max 10 minuti) su questo item Archive.org')
  return {
    id,
    title,
    fileName: picked.name,
    url: `https://archive.org/download/${encodeURIComponent(id)}/${picked.name.split('/').map(encodeURIComponent).join('/')}`,
    type: AUDIO_MIME[picked.ext] || 'application/octet-stream',
    duration: picked.length,
  }
}

export async function downloadArchiveBytes(fileUrl, typeHint) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  try {
    const response = await fetch(fileUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'PianoSmith/1.0 (https://pianosmith.vige.it; archive.org client)',
        Accept: 'audio/*,application/octet-stream,*/*',
      },
    })
    if (!response.ok) throw new Error(`Archive.org download HTTP ${response.status}`)
    const announced = Number(response.headers.get('content-length') || 0)
    if (announced > MAX_BYTES) throw new Error('Audio troppo grande')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_BYTES) throw new Error('Audio troppo grande')
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (data.length < 1000) throw new Error('Audio scaricato vuoto')
    const type = (response.headers.get('content-type') || '').split(';')[0].trim() || typeHint || 'application/octet-stream'
    return { data, type }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Download scaduto')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function downloadArchiveItem(input, titleOverride) {
  const id = archiveIdentifier(input)
  if (!id) throw new Error('Link Archive.org non valido')
  console.log('[archive] resolve', { id })
  const resolved = await resolveArchiveAudio(id)
  if (resolved.duration > MAX_SECONDS) throw new Error('Il brano supera i 10 minuti')
  console.log('[archive] download', { id, file: resolved.fileName })
  const { data, type } = await downloadArchiveBytes(resolved.url, resolved.type)
  console.log('[archive] ok', { id, bytes: data.length })
  return {
    title: (titleOverride || resolved.title).slice(0, 180),
    data,
    type: type.startsWith('audio/') ? type : resolved.type,
  }
}

export async function archiveReachable() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch('https://archive.org/advancedsearch.php?q=mediatype:audio&rows=0&output=json', {
      signal: controller.signal,
      headers: { 'User-Agent': 'PianoSmith/1.0' },
    }).finally(() => clearTimeout(timer))
    return response.ok
  } catch {
    return false
  }
}
