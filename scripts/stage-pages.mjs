/**
 * Build the SPA into docs/app for GitHub Pages (https://pianosmith.vige.it/app/).
 * Native/Tizen keep the relative-base build in `www/` from the main vite build.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs', 'app')

rmSync(outDir, { recursive: true, force: true })

const vite = path.join(root, 'node_modules', '.bin', 'vite')
const cmd = existsSync(vite) ? vite : 'vite'
const result = spawnSync(
  cmd,
  ['build', '--base=/app/', `--outDir=${outDir}`],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
)

if (result.status !== 0) {
  console.error('GitHub Pages build failed')
  process.exit(result.status || 1)
}

console.log(`Staged GitHub Pages app in docs/app/ (base /app/)`)
