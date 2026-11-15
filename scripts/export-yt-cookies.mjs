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
 *   npm run cookies:export -- remote
 *   npm run cookies:export -- chrome remote
 *
 * Prefer YTDLP_COOKIES_B64 on Railway (see yt-cookies.b64).
 * With `remote`, sets the Railway service variable via the Railway CLI (env secret, no volume).
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

function resolveRailwayBin() {
  const probe = spawnSync('railway', ['--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) return { cmd: 'railway', prefix: [] }
  const npx = spawnSync('npx', ['--yes', '@railway/cli', '--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (!npx.error && npx.status === 0) return { cmd: 'npx', prefix: ['--yes', '@railway/cli'] }
  return null
}

function uploadRailwayVariable(b64Path, fileEnv) {
  const varName =
    fileEnv.RAILWAY_VARIABLE_YTDLP_COOKIES_B64 ||
    process.env.RAILWAY_VARIABLE_YTDLP_COOKIES_B64 ||
    'YTDLP_COOKIES_B64'
  const service = fileEnv.RAILWAY_SERVICE || process.env.RAILWAY_SERVICE || ''
  const environment = fileEnv.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT || ''
  const project = fileEnv.RAILWAY_PROJECT_ID || process.env.RAILWAY_PROJECT_ID || ''
  const skipDeploys = /^(1|true|yes)$/i.test(
    String(fileEnv.RAILWAY_SKIP_DEPLOYS || process.env.RAILWAY_SKIP_DEPLOYS || ''),
  )

  const bin = resolveRailwayBin()
  if (!bin) {
    console.error(
      'Railway CLI not found. Install it (https://docs.railway.com/guides/cli) or ensure npx can run @railway/cli.',
    )
    process.exit(1)
  }

  const args = [...bin.prefix, 'variable', 'set', varName, '--stdin']
  if (service) args.push('--service', service)
  if (environment) args.push('--environment', environment)
  if (project) args.push('--project', project)
  if (skipDeploys) args.push('--skip-deploys')

  const b64 = readFileSync(b64Path, 'utf8').replace(/\s+/g, '')
  if (b64.length < 16) {
    console.error(`Refusing to upload empty/short ${path.basename(b64Path)}`)
    process.exit(1)
  }

  console.log(
    `Uploading ${path.basename(b64Path)} → Railway variable ${varName}` +
      (service ? ` (service ${service})` : '') +
      (skipDeploys ? ' [--skip-deploys]' : ' [triggers redeploy]') +
      '…',
  )

  const upload = spawnSync(bin.cmd, args, {
    encoding: 'utf8',
    input: b64,
    shell: process.platform === 'win32',
    env: process.env,
  })
  if (upload.status !== 0) {
    console.error(upload.stderr || upload.stdout || 'railway variable set failed')
    console.error(
      '\nTip: run `railway login` and `railway link` in this repo, or set RAILWAY_TOKEN + RAILWAY_SERVICE in .env',
    )
    process.exit(upload.status || 1)
  }
  console.log((upload.stdout || '').trim() || `Updated Railway variable ${varName}.`)
  if (skipDeploys) {
    console.log('Skipped redeploy. Restart/redeploy the Railway service so it reloads YTDLP_COOKIES_B64.')
  } else {
    console.log(
      'Railway will redeploy so the new env is picked up. Check GET /api/health → cookies.source=b64, cookies.ok=true.',
    )
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
  console.error('No YouTube cookies found. Open YouTube in that browser and retry.')
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
Wrote ${b64Path} (single-line Base64 for Railway Variables)
`)

if (remote) {
  uploadRailwayVariable(b64Path, fileEnv)
} else {
  console.log(`Recommended on Railway:
  1. Delete any broken YTDLP_COOKIES multiline variable
  2. Set YTDLP_COOKIES_B64 from yt-cookies.b64, or: npm run cookies:export -- remote
  3. Redeploy / restart (remote does this unless RAILWAY_SKIP_DEPLOYS=1)
  4. Check GET /api/health → cookies.ok should be true

Alternatives: YTDLP_COOKIES_URL or YTDLP_COOKIES_FILE.

Do not commit yt-cookies.txt / yt-cookies.b64 / .env — they are secrets.
`)
}
