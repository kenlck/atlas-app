import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skipDirs = new Set([
  'node_modules',
  '.git',
  'artifacts',
  'dist',
  '.output',
  '.tanstack',
  'test-results',
  'playwright-report',
])
const textExt = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
])
const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g
const arbitrary =
  /\[[^\]]*(?:#[0-9a-fA-F]{3,8}|-?\d*\.?\d+(?:px|rem|em|vh|vw|%|ch|svh|dvh|fr))[^\]]*\]/g

function themeSpan(text) {
  const start = text.indexOf(':root {')
  if (start < 0) return null
  const end = text.indexOf('\n}', start)
  if (end < 0) return null
  return [start, end]
}

function allowed(file, index, text) {
  if (!file.endsWith('src/styles.css')) return false
  const span = themeSpan(text)
  if (!span) return false
  return index > span[0] && index < span[1]
}

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (relative(root, path) === join('tests', 'fixtures', 'clipboard')) continue
    if (entry.isDirectory()) {
      await walk(path, out)
      continue
    }
    if (entry.name === 'pnpm-lock.yaml' || entry.name.endsWith('.lock')) continue
    const ext = extname(entry.name).toLowerCase()
    if (ext === '.svg') continue
    if (!textExt.has(ext)) continue
    out.push(path)
  }
}

const files = []
await walk(root, files)
const failures = []
for (const file of files) {
  const text = await readFile(file, 'utf8')
  const rel = relative(root, file)
  for (const match of text.matchAll(hex)) {
    if (allowed(rel, match.index ?? 0, text)) continue
    const line = text.slice(0, match.index).split('\n').length
    failures.push(`${rel}:${line} raw hex ${match[0]}`)
  }
  for (const match of text.matchAll(arbitrary)) {
    const line = text.slice(0, match.index).split('\n').length
    failures.push(`${rel}:${line} arbitrary value ${match[0]}`)
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(line)
  console.error(`token lint failed (${failures.length})`)
  process.exit(1)
}
console.log('token lint passed')
