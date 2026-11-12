/** In-memory MIDI relay: phone POSTs notes, TV listens via SSE. */

const ROOM_TTL_MS = 45 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** @type {Map<string, { tv: Set<import('node:http').ServerResponse>, events: object[], updated: number }>} */
const rooms = new Map()

function cleanCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

export function newRoomCode() {
  let code = ''
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
  if (!rooms.has(code)) rooms.set(code, { tv: new Set(), events: [], updated: Date.now() })
  return code
}

function roomOf(code) {
  const key = cleanCode(code)
  if (key.length < 4) return null
  let room = rooms.get(key)
  if (!room) {
    room = { tv: new Set(), events: [], updated: Date.now() }
    rooms.set(key, room)
  }
  room.updated = Date.now()
  return { key, room }
}

function pruneRooms() {
  const now = Date.now()
  for (const [key, room] of rooms) {
    if (now - room.updated > ROOM_TTL_MS && room.tv.size === 0) rooms.delete(key)
  }
}

function sseWrite(res, event, data) {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(room, event, data) {
  for (const res of [...room.tv]) {
    try {
      sseWrite(res, event, data)
    } catch {
      room.tv.delete(res)
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} sendJson
 * @param {(req: import('node:http').IncomingMessage) => Promise<Buffer>} readBody
 */
export async function handleMidiBridge(req, res, url, sendJson, readBody) {
  pruneRooms()
  const parts = url.pathname.split('/').filter(Boolean)
  // /api/midi/room | /api/midi/:code[/stream]
  if (parts[0] !== 'api' || parts[1] !== 'midi') return false

  if (parts[2] === 'room' && req.method === 'POST') {
    sendJson(res, 200, { code: newRoomCode() })
    return true
  }

  const code = parts[2]
  const action = parts[3] || ''
  const hit = roomOf(code)
  if (!hit) {
    sendJson(res, 400, { message: 'Codice stanza non valido' })
    return true
  }
  const { key, room } = hit

  if (req.method === 'GET' && action === 'stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write(': ok\n\n')
    sseWrite(res, 'hello', { room: key, role: 'tv' })
    room.tv.add(res)
    req.on('close', () => {
      room.tv.delete(res)
    })
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat)
        return
      }
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
        room.tv.delete(res)
      }
    }, 15000)
    req.on('close', () => clearInterval(heartbeat))
    return true
  }

  if (req.method === 'POST' && !action) {
    const raw = await readBody(req)
    let body = {}
    try {
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, { message: 'JSON non valido' })
      return true
    }
    const type = body.t === 'off' || body.type === 'noteoff' ? 'off' : 'on'
    const midi = Math.round(Number(body.n ?? body.midi))
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
      sendJson(res, 400, { message: 'Nota MIDI non valida' })
      return true
    }
    const velocity = Math.max(0, Math.min(127, Math.round(Number(body.v ?? body.velocity ?? 100))))
    const payload = { t: type, n: midi, v: velocity, at: Date.now() }
    room.events.push(payload)
    if (room.events.length > 64) room.events.splice(0, room.events.length - 64)
    broadcast(room, 'midi', payload)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (req.method === 'GET' && !action) {
    sendJson(res, 200, { room: key, listeners: room.tv.size })
    return true
  }

  sendJson(res, 404, { message: 'Not found' })
  return true
}
