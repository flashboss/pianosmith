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
 * With `remote`, sets the Railway service variable via the Railway CLI (env secret, no volume),
 * then redeploys only after the variable is verified — avoids the race where a redeploy
 * starts before Railway has assimilated the new secret.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowed = new Set(['chrome', 'chromium', 'firefox', 'safari', 'edge', 'brave', 'opera'])
const isWin = process.platform === 'win32'

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
    shell: isWin,
  })
  if (!npx.error && npx.status === 0) return { cmd: 'npx', prefix: ['--yes', '@railway/cli'] }
  return null
}

function railwayContext(fileEnv) {
  return {
    varName:
      fileEnv.RAILWAY_VARIABLE_YTDLP_COOKIES_B64 ||
      process.env.RAILWAY_VARIABLE_YTDLP_COOKIES_B64 ||
      'YTDLP_COOKIES_B64',
    service: fileEnv.RAILWAY_SERVICE || process.env.RAILWAY_SERVICE || '',
    environment: fileEnv.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT || '',
    project: fileEnv.RAILWAY_PROJECT_ID || process.env.RAILWAY_PROJECT_ID || '',
    skipDeploys: /^(1|true|yes)$/i.test(
      String(fileEnv.RAILWAY_SKIP_DEPLOYS || process.env.RAILWAY_SKIP_DEPLOYS || ''),
    ),
    healthUrl: (
      fileEnv.RAILWAY_HEALTH_URL ||
      process.env.RAILWAY_HEALTH_URL ||
      ''
    ).trim(),
  }
}

function withRailwayScope(args, ctx) {
  const out = [...args]
  if (ctx.service) out.push('--service', ctx.service)
  if (ctx.environment) out.push('--environment', ctx.environment)
  if (ctx.project) out.push('--project', ctx.project)
  return out
}

function runRailway(bin, args, opts = {}) {
  return spawnSync(bin.cmd, [...bin.prefix, ...args], {
    encoding: 'utf8',
    shell: isWin,
    env: process.env,
    ...opts,
  })
}

function parseJsonOutput(result, label) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${text || `exit ${result.status}`}`)
  }
  try {
    return JSON.parse(result.stdout || 'null')
  } catch {
    throw new Error(`${label} returned non-JSON output`)
  }
}

function readRailwayVariable(bin, ctx, varName) {
  const listed = parseJsonOutput(
    runRailway(bin, withRailwayScope(['variable', 'list', '--json'], ctx)),
    'railway variable list',
  )
  const vars = Array.isArray(listed)
    ? Object.fromEntries(listed.map((v) => [v.name || v.key, v.value ?? v.val]))
    : listed?.variables || listed || {}
  return String(vars[varName] ?? '').replace(/\s+/g, '')
}

function listDeployments(bin, ctx) {
  const listed = parseJsonOutput(
    runRailway(bin, withRailwayScope(['deployment', 'list', '--json'], ctx)),
    'railway deployment list',
  )
  return Array.isArray(listed) ? listed : listed?.deployments || []
}

function latestDeployment(bin, ctx) {
  const deployments = listDeployments(bin, ctx)
  return deployments[0] || null
}

function toHealthUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  if (/\/api\/health\/?$/i.test(value)) return value.replace(/\/$/, '')
  return `${value.replace(/\/$/, '')}/api/health`
}

function resolveServiceHealthUrl(bin, ctx) {
  const configured = toHealthUrl(ctx.healthUrl)
  if (configured) return configured.startsWith('http') ? configured : `https://${configured}`

  const status = parseJsonOutput(runRailway(bin, ['status', '--json']), 'railway status')
  const domains = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'string' && /\.up\.railway\.app$/i.test(value)) {
        domains.push(value.replace(/^https?:\/\//, ''))
      } else if (value && typeof value === 'object') {
        walk(value)
      }
    }
  }
  walk(status)
  const preferred = ctx.service
    ? domains.find((d) => d.toLowerCase().includes(String(ctx.service).toLowerCase()))
    : null
  const host = preferred || domains[0]
  return host ? `https://${host}/api/health` : null
}

async function waitForNewDeployment(bin, ctx, previousId, timeoutMs = 5 * 60 * 1000) {
  const started = Date.now()
  let lastStatus = ''
  while (Date.now() - started < timeoutMs) {
    const latest = latestDeployment(bin, ctx)
    if (latest) {
      const status = String(latest.status || '')
      if (latest.id !== previousId) {
        if (status !== lastStatus) {
          console.log(`Redeploy ${latest.id.slice(0, 8)}… status=${status}`)
          lastStatus = status
        }
        if (/^SUCCESS$/i.test(status)) return latest
        if (/^(FAILED|CRASHED|REMOVED)$/i.test(status)) {
          throw new Error(`Redeploy ended with status ${status}`)
        }
      }
    }
    await sleep(4000)
  }
  throw new Error('Timed out waiting for Railway redeploy to succeed')
}

async function waitForCookiesHealth(healthUrl, expectedBytes, timeoutMs = 2 * 60 * 1000) {
  if (!healthUrl) {
    console.log('No public Railway URL found; skip /api/health poll. Check it manually.')
    return
  }
  console.log(`Waiting for ${healthUrl} → cookies.source=b64, cookies.ok=true…`)
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { redirect: 'follow' })
      const body = await response.json()
      const cookies = body?.cookies || {}
      if (cookies.source === 'b64' && cookies.ok === true) {
        if (expectedBytes && cookies.bytes && cookies.bytes !== expectedBytes) {
          lastError = `cookies.bytes=${cookies.bytes}, expected ${expectedBytes}`
        } else {
          console.log(
            `Health OK (cookies.bytes=${cookies.bytes ?? expectedBytes}, source=${cookies.source}).`,
          )
          return
        }
      } else {
        lastError = `ok=${cookies.ok} source=${cookies.source} error=${cookies.error || 'n/a'}`
      }
    } catch (error) {
      lastError = String(error?.message || error)
    }
    await sleep(3000)
  }
  throw new Error(`Timed out waiting for healthy cookies (${lastError})`)
}

async function uploadRailwayVariable(b64Path, fileEnv, expectedBytes) {
  const ctx = railwayContext(fileEnv)
  const bin = resolveRailwayBin()
  if (!bin) {
    console.error(
      'Railway CLI not found. Install it (https://docs.railway.com/guides/cli) or ensure npx can run @railway/cli.',
    )
    process.exit(1)
  }

  const b64 = readFileSync(b64Path, 'utf8').replace(/\s+/g, '')
  if (b64.length < 16) {
    console.error(`Refusing to upload empty/short ${path.basename(b64Path)}`)
    process.exit(1)
  }

  // Always skip the CLI's immediate redeploy: it can race ahead of variable assimilation.
  // We set the secret first, verify it, then redeploy explicitly.
  console.log(
    `Uploading ${path.basename(b64Path)} → Railway variable ${ctx.varName}` +
      (ctx.service ? ` (service ${ctx.service})` : '') +
      ' [--skip-deploys, then redeploy]…',
  )

  const upload = runRailway(
    bin,
    withRailwayScope(['variable', 'set', ctx.varName, '--stdin', '--skip-deploys'], ctx),
    { input: b64 },
  )
  if (upload.status !== 0) {
    console.error(upload.stderr || upload.stdout || 'railway variable set failed')
    console.error(
      '\nTip: run `railway login` and `railway link` in this repo, or set RAILWAY_TOKEN + RAILWAY_SERVICE in .env',
    )
    process.exit(upload.status || 1)
  }
  console.log((upload.stdout || '').trim() || `Updated Railway variable ${ctx.varName}.`)

  console.log('Verifying variable is stored…')
  let stored = ''
  for (let attempt = 0; attempt < 10; attempt++) {
    stored = readRailwayVariable(bin, ctx, ctx.varName)
    if (stored === b64) break
    await sleep(1500)
  }
  if (stored !== b64) {
    console.error(
      `Railway variable ${ctx.varName} does not match uploaded Base64 yet (got ${stored.length} chars, expected ${b64.length}).`,
    )
    process.exit(1)
  }
  console.log(`Variable ${ctx.varName} verified (${stored.length} chars).`)

  if (ctx.skipDeploys) {
    console.log(
      'RAILWAY_SKIP_DEPLOYS=1 — not redeploying. Run `railway redeploy -y` (or Deploy in the console) so the service reloads YTDLP_COOKIES_B64.',
    )
    return
  }

  const previous = latestDeployment(bin, ctx)
  const previousId = previous?.id || null
  console.log(
    previousId
      ? `Redeploying after variable assimilate (previous deploy ${previousId.slice(0, 8)}…)…`
      : 'Redeploying after variable assimilate…',
  )
  const redeploy = runRailway(bin, withRailwayScope(['redeploy', '--yes'], ctx))
  if (redeploy.status !== 0) {
    console.error(redeploy.stderr || redeploy.stdout || 'railway redeploy failed')
    process.exit(redeploy.status || 1)
  }
  console.log((redeploy.stdout || '').trim() || 'Redeploy started.')

  await waitForNewDeployment(bin, ctx, previousId)
  const healthUrl = resolveServiceHealthUrl(bin, ctx)
  await waitForCookiesHealth(healthUrl, expectedBytes)
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
  await uploadRailwayVariable(b64Path, fileEnv, bytes)
} else {
  console.log(`Recommended on Railway:
  1. Delete any broken YTDLP_COOKIES multiline variable
  2. Set YTDLP_COOKIES_B64 from yt-cookies.b64, or: npm run cookies:export -- remote
  3. remote sets the variable first, verifies it, then redeploys (unless RAILWAY_SKIP_DEPLOYS=1)
  4. Wait until GET /api/health → cookies.ok=true (remote polls this)

Alternatives: YTDLP_COOKIES_URL or YTDLP_COOKIES_FILE.

Do not commit yt-cookies.txt / yt-cookies.b64 / .env — they are secrets.
`)
}
