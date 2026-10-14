#!/usr/bin/env node
/**
 * Export YouTube-related cookies from a local browser for remote PianoSmith hosts.
 *
 * Full browser dumps are huge and often exceed Railway variable size limits, so this
 * script keeps only YouTube / Google cookie lines (usually a few KB).
 *
 * Usage:
 *   npm run cookies:export
 *   npm run cookies:export -- chrome
 *   npm run cookies:export -- firefox
 *   npm run cookies:export -- safari
 *
 * Then either:
 *   - paste yt-cookies.txt into YTDLP_COOKIES (small enough after filtering), or
 *   - host the file privately and set YTDLP_COOKIES_URL, or
 *   - mount the file and set YTDLP_COOKIES_FILE
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const browser = (process.argv[2] || 'chrome').toLowerCase()
const out = path.resolve('yt-cookies.txt')
const allowed = new Set(['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera'])

/** Domains yt-dlp needs for YouTube auth / consent. */
const KEEP =
  /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|google\.com|googleapis\.com|gstatic\.com|youtube-nocookie\.com)$/i

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
  const domain = (line.split('\t')[0] || '').toLowerCase()
  const host = domain.replace(/^\./, '')
  if (KEEP.test(domain) || KEEP.test(host) || KEEP.test(`.${host}`)) kept.push(line)
}

if (!kept.some((line) => line && !line.startsWith('#'))) {
  console.error('No YouTube/Google cookies found. Log into YouTube in that browser and retry.')
  process.exit(1)
}

const header = kept.some((line) => line.startsWith('# Netscape'))
  ? ''
  : '# Netscape HTTP Cookie File\n# Filtered for YouTube / Google (PianoSmith)\n'
const filtered = `${header}${kept.join('\n').trim()}\n`
writeFileSync(out, filtered, 'utf8')

const bytes = Buffer.byteLength(filtered)
const kb = (bytes / 1024).toFixed(1)
console.log(`
Wrote ${out} (${kb} KB, YouTube/Google only)

Railway Variables (file is small enough for most plans):
  1. Open the service → Variables
  2. Set YTDLP_COOKIES to the contents of yt-cookies.txt
  3. Redeploy / restart

If the variable is still rejected:
  - Host yt-cookies.txt on a private URL and set YTDLP_COOKIES_URL
  - Or mount a volume and set YTDLP_COOKIES_FILE=/data/yt-cookies.txt

Do not commit yt-cookies.txt — it is a login secret.
`)
