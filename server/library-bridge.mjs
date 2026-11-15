/** Temporary library transfer rooms: upload bundle, peer downloads via code. */

import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOM_TTL_MS = 45 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_ROOM_BYTES = 220 * 1024 * 1024
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_SONGS = 40

/** @type {Map<string, { dir: string, ready: boolean, bytes: number, listeners: Set<import('node:http').ServerResponse>, updated: number }>} */
const rooms = new Map()

function cleanCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

function safeName(raw) {
  const name = String(raw || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return name || null
}

function newRoomCode() {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = ''
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
    if (!rooms.has(code)) return code
  }
  throw new Error('Impossibile creare una stanza libreria')
}

async function ensureRoom(code) {
  const key = cleanCode(code)
  if (key.length < 4) return null
  let room = rooms.get(key)
  if (!room) {
    const dir = path.join(os.tmpdir(), `pianosmith-lib-${key}-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    room = {
      dir,
      ready: false,
      bytes: 0,
      listeners: new Set(),
      updated: Date.now(),
    }
    rooms.set(key, room)
  }
  room.updated = Date.now()
  return { key, room }
}

async function destroyRoom(key) {
  const room = rooms.get(key)
  if (!room) return
  rooms.delete(key)
  for (const res of room.listeners) {
    try {
      res.end()
    } catch {
      /* ignore */
    }
  }
  room.listeners.clear()
  await rm(room.dir, { recursive: true, force: true }).catch(() => undefined)
}

async function pruneRooms() {
  const now = Date.now()
  for (const [key, room] of rooms) {
    if (now - room.updated > ROOM_TTL_MS) await destroyRoom(key)
  }
}

function sseWrite(res, event, data) {
  if (res.writableEnded) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(room, event, data) {
  for (const res of [...room.listeners]) {
    try {
      sseWrite(res, event, data)
    } catch {
      room.listeners.delete(res)
    }
  }
}

function readBody(req, limit) {
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

function pipeToFile(req, filePath, limit, alreadyUsed) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath)
    let size = 0
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      req.destroy()
      ws.destroy()
      rm(filePath, { force: true }).catch(() => undefined)
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (alreadyUsed + size > MAX_ROOM_BYTES || size > limit) {
        fail(new Error('Pacchetto libreria troppo grande'))
      }
    })
    req.on('error', fail)
    ws.on('error', fail)
    ws.on('finish', () => {
      if (!failed) resolve(size)
    })
    req.pipe(ws)
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} sendJson
 */
export async function handleLibraryBridge(req, res, url, sendJson) {
  await pruneRooms()
  const parts = url.pathname.split('/').filter(Boolean)
  // /api/library/room | /api/library/:code/...
  if (parts[0] !== 'api' || parts[1] !== 'library') return false

  if (parts[2] === 'room' && req.method === 'POST') {
    const code = newRoomCode()
    await ensureRoom(code)
    sendJson(res, 200, { code })
    return true
  }

  const code = parts[2]
  const hit = await ensureRoom(code)
  if (!hit) {
    sendJson(res, 400, { message: 'Codice stanza non valido' })
    return true
  }
  const { key, room } = hit
  const action = parts[3] || ''
  const name = parts[4] || ''

  if (req.method === 'GET' && action === 'stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write(': ok\n\n')
    sseWrite(res, 'hello', { room: key, ready: room.ready })
    if (room.ready) sseWrite(res, 'ready', { room: key })
    room.listeners.add(res)
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat)
        return
      }
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
        room.listeners.delete(res)
      }
    }, 15000)
    req.on('close', () => {
      clearInterval(heartbeat)
      room.listeners.delete(res)
    })
    return true
  }

  if (req.method === 'GET' && action === 'status') {
    const manifestPath = path.join(room.dir, 'manifest.json')
    let songs = 0
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        songs = Array.isArray(manifest?.songs) ? manifest.songs.length : 0
      } catch {
        songs = 0
      }
    }
    sendJson(res, 200, { room: key, ready: room.ready, bytes: room.bytes, songs, listeners: room.listeners.size })
    return true
  }

  if (req.method === 'PUT' && action === 'manifest') {
    const raw = await readBody(req, MAX_MANIFEST_BYTES)
    let body
    try {
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, { message: 'Manifest non valido' })
      return true
    }
    if (!body || body.version !== 1 || !Array.isArray(body.folders) || !Array.isArray(body.songs)) {
      sendJson(res, 400, { message: 'Manifest non valido' })
      return true
    }
    if (body.songs.length > MAX_SONGS) {
      sendJson(res, 400, { message: `Massimo ${MAX_SONGS} brani` })
      return true
    }
    room.ready = false
    await writeFile(path.join(room.dir, 'manifest.json'), JSON.stringify(body))
    room.updated = Date.now()
    broadcast(room, 'status', { ready: false, songs: body.songs.length })
    sendJson(res, 200, { ok: true, songs: body.songs.length })
    return true
  }

  if ((req.method === 'PUT' || req.method === 'GET') && action === 'file') {
    const fileName = safeName(name)
    if (!fileName) {
      sendJson(res, 400, { message: 'Nome file non valido' })
      return true
    }
    const filePath = path.join(room.dir, fileName)
    if (!filePath.startsWith(room.dir)) {
      sendJson(res, 400, { message: 'Nome file non valido' })
      return true
    }

    if (req.method === 'PUT') {
      room.ready = false
      const size = await pipeToFile(req, filePath, MAX_FILE_BYTES, room.bytes)
      room.bytes += size
      room.updated = Date.now()
      sendJson(res, 200, { ok: true, bytes: size })
      return true
    }

    if (!existsSync(filePath)) {
      sendJson(res, 404, { message: 'File non trovato' })
      return true
    }
    const info = await stat(filePath)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': info.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    createReadStream(filePath).pipe(res)
    return true
  }

  if (req.method === 'POST' && action === 'ready') {
    const manifestPath = path.join(room.dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      sendJson(res, 400, { message: 'Carica prima il manifest' })
      return true
    }
    room.ready = true
    room.updated = Date.now()
    broadcast(room, 'ready', { room: key })
    sendJson(res, 200, { ok: true, room: key })
    return true
  }

  if (req.method === 'GET' && action === 'manifest') {
    const manifestPath = path.join(room.dir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      sendJson(res, 404, { message: 'Nessuna libreria in questa stanza' })
      return true
    }
    const raw = await readFile(manifestPath)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': raw.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(raw)
    return true
  }

  if (req.method === 'DELETE' && !action) {
    await destroyRoom(key)
    sendJson(res, 200, { ok: true })
    return true
  }

  sendJson(res, 404, { message: 'Not found' })
  return true
}
