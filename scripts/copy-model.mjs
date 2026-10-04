import { cpSync, existsSync, mkdirSync } from 'node:fs'

const src = 'node_modules/@spotify/basic-pitch/model'
const dest = 'public/model'
if (!existsSync(src)) {
  console.warn('basic-pitch model not installed yet')
  process.exit(0)
}
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('Copied Basic Pitch model to public/model')
