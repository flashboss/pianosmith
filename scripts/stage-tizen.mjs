import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing. Run vite build first.')
  process.exit(1)
}
rmSync('tizen-app', { recursive: true, force: true })
mkdirSync('tizen-app', { recursive: true })
cpSync('dist', 'tizen-app', { recursive: true })
cpSync('tizen/config.xml', path.join('tizen-app', 'config.xml'))
if (existsSync('tizen/icon.png')) cpSync('tizen/icon.png', path.join('tizen-app', 'icon.png'))
console.log('Staged Tizen package in tizen-app/')
