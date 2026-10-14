#!/usr/bin/env node
/**
 * Export YouTube-related cookies from a local browser for remote PianoSmith hosts.
 *
 * Full browser dumps are huge and often exceed Railway variable size limits, so this
 * script keeps only domains yt-dlp needs for YouTube (not Gmail/Drive/Meet/etc.).
 *
 * Usage:
 *   npm run cookies:export
 *   npm run cookies:export -- chrome
 *   npm run cookies:export -- firefox
 *   npm run cookies:export -- safari
 *
 * Prefer YTDLP_COOKIES_B64 on Railway (see yt-cookies.b64).
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const browser = (process.argv[2] || 'chrome').toLowerCase()
const out = path.resolve('yt-cookies.txt')
const allowed = new Set(['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera'])

/**
 * Keep YouTube media hosts + root/account Google cookies used for login/consent.
 * Drop product subdomains (mail, drive, meet, calendar, play, …).
 */
function keepHost(domainField) {
  const host = String(domainField || '')
    .toLowerCase()
    .replace(/^\./, '')
  if (!host) return false
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) return true
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) return true
  if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return true
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return true
  // Auth / consent cookies live on the registrable Google domain or accounts — not on apps.
  if (host === 'google.com' || host === 'www.google.com' || host === 'accounts.google.com') return true
  return false
}

if (!allowed.has(browser)) {
  console.error(`Unknown browser "${browser}". Use: ${[...allowed].join(', ')}`)
  process.exit(1)
}

const probe = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.error('yt-dlp not found. Install it locally (e.g. brew install yt-dlp).')
  process.exit(1)
}

console.log(`Exporting cookies from ${browser}…`)
const result = spawnSync(
  'yt-dlp',
  ['--cookies-from-browser', browser, '--cookies', out, '--skip-download', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  { encoding: 'utf8' },
)

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'yt-dlp failed')
  console.error('\nClose the browser and retry, or try another browser name.')
  process.exit(result.status || 1)
}

if (!existsSync(out) || readFileSync(out, 'utf8').trim().length < 20) {
  console.error('Cookie file was not written. Is the browser installed and unlocked?')
  process.exit(1)
}

const raw = readFileSync(out, 'utf8')
const lines = raw.split(/\r?\n/)
const kept = []
for (const line of lines) {
  if (!line || line.startsWith('#')) {
    if (line.startsWith('#') || line === '') kept.push(line)
    continue
  }
  // Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
  const domain = line.includes('\t') ? line.split('\t')[0] : line.trim().split(/\s+/)[0]
  if (keepHost(domain)) kept.push(line)
}

if (!kept.some((line) => line && !line.startsWith('#'))) {
  console.error('No YouTube cookies found. Log into YouTube in that browser and retry.')
  process.exit(1)
}

const header = kept.some((line) => line.startsWith('# Netscape'))
  ? ''
  : '# Netscape HTTP Cookie File\n# Filtered for YouTube only (PianoSmith)\n'
const filtered = `${header}${kept.join('\n').trim()}\n`
writeFileSync(out, filtered, 'utf8')
const b64Path = path.resolve('yt-cookies.b64')
const b64 = Buffer.from(filtered, 'utf8').toString('base64')
writeFileSync(b64Path, b64, 'utf8')

const cookieLines = kept.filter((line) => line && !line.startsWith('#')).length
const bytes = Buffer.byteLength(filtered)
const kb = (bytes / 1024).toFixed(1)
console.log(`
Wrote ${out} (${kb} KB, ${cookieLines} cookie lines — youtube/accounts/google root only)
Wrote ${b64Path} (single-line Base64 for Railway Variables)

Recommended on Railway:
  1. Delete any broken YTDLP_COOKIES multiline variable
  2. Add YTDLP_COOKIES_B64 = contents of yt-cookies.b64 (one line, paste works)
  3. Redeploy / restart
  4. Check GET /api/health → cookies.ok should be true

Alternatives: YTDLP_COOKIES_URL or YTDLP_COOKIES_FILE.

Do not commit yt-cookies.txt / yt-cookies.b64 — they are login secrets.
`)
