#!/usr/bin/env node
/**
 * Export YouTube cookies from a local browser for remote PianoSmith hosts.
 *
 * Cloud IPs (Railway, etc.) are often blocked by YouTube. Cookies from a logged-in
 * desktop browser usually unblock yt-dlp. Re-run this when downloads start failing.
 *
 * Usage:
 *   npm run cookies:export
 *   npm run cookies:export -- chrome
 *   npm run cookies:export -- firefox
 *   npm run cookies:export -- safari
 *
 * Then set the Railway/host secret YTDLP_COOKIES to the file contents, or mount the
 * file and set YTDLP_COOKIES_FILE. Prefer a residential YTDLP_PROXY if you need
 * fully unattended downloads without refreshing cookies.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const browser = (process.argv[2] || 'chrome').toLowerCase()
const out = path.resolve('yt-cookies.txt')
const allowed = new Set(['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera'])

if (!allowed.has(browser)) {
  console.error(`Unknown browser "${browser}". Use: ${[...allowed].join(', ')}`)
  process.exit(1)
}

const probe = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.error('yt-dlp not found. Install it locally (e.g. brew install yt-dlp).')
  process.exit(1)
}

console.log(`Exporting cookies from ${browser} → ${out}`)
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

console.log(`
Wrote ${out}

Remote host (Railway / Docker):
  1. Open the host secrets / variables
  2. Set YTDLP_COOKIES to the full contents of yt-cookies.txt
     (or copy the file into the container and set YTDLP_COOKIES_FILE)
  3. Redeploy or restart the service

Do not commit yt-cookies.txt — it is a login secret.
`)
