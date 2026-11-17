/** In-memory MIDI relay: phone POSTs notes, TV listens via SSE. */

const ROOM_TTL_MS = 45 * 60 * 1000
const HEARTBEAT_MS = 10_000
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
    // Keep rooms with live SSE listeners even if notes are idle.
    if (room.tv.size > 0) continue
    if (now - room.updated > ROOM_TTL_MS) rooms.delete(key)
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
    // Disable socket timeout so the display can stay listening for hours.
    req.socket?.setTimeout?.(0)
    res.write(': ok\n\n')
    sseWrite(res, 'hello', { room: key, role: 'tv' })
    room.tv.add(res)
    room.updated = Date.now()

    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat)
        return
      }
      try {
        room.updated = Date.now()
        // Comment + named event: proxies keep the connection; clients can watch liveness.
        res.write(': ping\n\n')
        sseWrite(res, 'ping', { at: Date.now(), listeners: room.tv.size })
      } catch {
        clearInterval(heartbeat)
        room.tv.delete(res)
      }
    }, HEARTBEAT_MS)

    const cleanup = () => {
      clearInterval(heartbeat)
      room.tv.delete(res)
      room.updated = Date.now()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    return true
  }

  if (req.method === 'POST' && !action) {
    // Touch room so TTL stays alive while the keyboard is sending.
    room.updated = Date.now()
    if (room.tv.size === 0) {
      sendJson(res, 503, {
        ok: false,
        message: 'Nessuno schermo in ascolto (ponte MIDI addormentato o disconnesso)',
        listeners: 0,
      })
      return true
    }
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
    sendJson(res, 200, { ok: true, listeners: room.tv.size })
    return true
  }

  if (req.method === 'GET' && !action) {
    sendJson(res, 200, { room: key, listeners: room.tv.size, updated: room.updated })
    return true
  }

  // Lightweight keepalive used by display/keyboard clients so hosted Node (Railway)
  // does not idle-sleep while a bridge session is open.
  if (req.method === 'POST' && action === 'keepalive') {
    room.updated = Date.now()
    sendJson(res, 200, { ok: true, room: key, listeners: room.tv.size })
    return true
  }

  sendJson(res, 404, { message: 'Not found' })
  return true
}
