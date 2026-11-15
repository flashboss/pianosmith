#!/usr/bin/env node
/**
 * Export YouTube-related cookies from a local browser for remote PianoSmith hosts.
 *
 * Full browser dumps are huge and often exceed cloud secret size limits, so this
 * script keeps only domains yt-dlp needs for YouTube (not Gmail/Drive/Meet/etc.).
 *
 * Usage:
 *   npm run cookies:export
 *   npm run cookies:export -- chrome
 *   npm run cookies:export -- firefox
 *   npm run cookies:export -- safari
 *   npm run cookies:export -- remote
 *   npm run cookies:export -- chrome remote
 *
 * Prefer YTDLP_COOKIES_B64 on Cloud Run (see yt-cookies.b64).
 * With `remote`, runs:
 *   gcloud secrets versions add YTDLP_COOKIES_B64 --data-file=yt-cookies.b64 --project=…
 * Mount that secret as a Cloud Run **volume** (not an env var) so new versions apply
 * without redeploy. Set YTDLP_COOKIES_B64_FILE to the mount path if it is not
 * /secrets/YTDLP_COOKIES_B64.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowed = new Set(['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera'])

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const env = {}
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function parseArgs(argv) {
  let browser = 'chrome'
  let remote = false
  for (const arg of argv) {
    const lower = arg.toLowerCase()
    if (lower === 'remote' || lower === '--remote') {
      remote = true
      continue
    }
    if (allowed.has(lower)) {
      browser = lower
      continue
    }
    console.error(`Unknown argument "${arg}". Use a browser name and/or remote.`)
    console.error(`Browsers: ${[...allowed].join(', ')}`)
    process.exit(1)
  }
  return { browser, remote }
}

/**
 * Keep only YouTube-related hosts (trial without .google.com auth cookies).
 * If cloud downloads hit bot/sign-in blocks again, restore google.com / www.google.com.
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
  return false
}

function uploadSecretB64(b64Path, fileEnv) {
  const project =
    fileEnv.GCLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    ''
  const secret =
    fileEnv.GCLOUD_SECRET_YTDLP_COOKIES_B64 ||
    process.env.GCLOUD_SECRET_YTDLP_COOKIES_B64 ||
    'YTDLP_COOKIES_B64'

  if (!project) {
    console.error(
      'Missing GCLOUD_PROJECT. Add it to .env (see .env.example) before using remote.',
    )
    process.exit(1)
  }

  const gcloudProbe = spawnSync('gcloud', ['--version'], { encoding: 'utf8' })
  if (gcloudProbe.error || gcloudProbe.status !== 0) {
    console.error('gcloud CLI not found. Install Google Cloud SDK and run gcloud auth login.')
    process.exit(1)
  }

  console.log(
    `Uploading ${b64Path} → gcloud secrets versions add ${secret} --data-file=… --project=${project}`,
  )
  const upload = spawnSync(
    'gcloud',
    ['secrets', 'versions', 'add', secret, `--data-file=${b64Path}`, `--project=${project}`],
    { encoding: 'utf8' },
  )
  if (upload.status !== 0) {
    console.error(upload.stderr || upload.stdout || 'gcloud secrets versions add failed')
    process.exit(upload.status || 1)
  }
  console.log((upload.stdout || '').trim() || 'Secret version added.')
  console.log(
    'Secret version added. With Cloud Run mounting this secret as a volume (:latest), ' +
      'no redeploy is needed — the next download re-reads the file. ' +
      'Ensure the service mounts the secret and YTDLP_COOKIES_B64_FILE points at that path ' +
      '(or use /secrets/YTDLP_COOKIES_B64).',
  )
  const service = fileEnv.GCLOUD_RUN_SERVICE || process.env.GCLOUD_RUN_SERVICE || ''
  const region = fileEnv.GCLOUD_RUN_REGION || process.env.GCLOUD_RUN_REGION || ''
  if (service && region) {
    console.log(`Service hint: ${service} (${region}, project ${project})`)
  }
}

const { browser, remote } = parseArgs(process.argv.slice(2))
const out = path.resolve(root, 'yt-cookies.txt')
const fileEnv = {
  ...loadEnvFile(path.resolve(root, '.env')),
  ...loadEnvFile(path.resolve(root, '.env.local')),
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
  { encoding: 'utf8', cwd: root },
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
  if (!line) continue
  // Real comments only — #HttpOnly_… is a cookie line, not a comment.
  if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) {
    kept.push(line)
    continue
  }
  // Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
  // HttpOnly export: #HttpOnly_.youtube.com\tTRUE\t…
  const field = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line
  const domain = field.includes('\t') ? field.split('\t')[0] : field.trim().split(/\s+/)[0]
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
const b64Path = path.resolve(root, 'yt-cookies.b64')
const b64 = Buffer.from(filtered, 'utf8').toString('base64')
writeFileSync(b64Path, b64, 'utf8')

const cookieLines = kept.filter((line) => line && !line.startsWith('#')).length
const bytes = Buffer.byteLength(filtered)
const kb = (bytes / 1024).toFixed(1)
console.log(`
Wrote ${out} (${kb} KB, ${cookieLines} cookie lines — youtube hosts only, no .google.com)
Wrote ${b64Path} (single-line Base64 for Cloud Run / secret env)
`)

if (remote) {
  uploadSecretB64(b64Path, fileEnv)
} else {
  console.log(`Recommended on Cloud Run:
  1. Mount Secret Manager secret YTDLP_COOKIES_B64 as a volume (prefer :latest)
  2. Set YTDLP_COOKIES_B64_FILE to the mount file path (or use /secrets/YTDLP_COOKIES_B64)
  3. Refresh cookies with: npm run cookies:export -- remote
     (gcloud secrets versions add … --data-file=yt-cookies.b64 — no redeploy)
  4. Check GET /api/health → cookies.ok should be true (source b64-volume)

Alternatives: env YTDLP_COOKIES_B64, YTDLP_COOKIES_URL, or Netscape YTDLP_COOKIES_FILE.

Do not commit yt-cookies.txt / yt-cookies.b64 / .env — they are secrets.
`)
}
