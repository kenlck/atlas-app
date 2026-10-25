import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const fromRef = process.env.BASELINE_FROM ?? 'origin/main'
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const outDir = join(process.cwd(), 'artifacts', sha, 'baseline-side-by-side')

function gitShow(path: string) {
  try {
    return execFileSync('git', ['show', `${fromRef}:${path}`], {
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function pngSize(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function panel(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  left: Buffer | null,
  right: Buffer,
  name: string,
) {
  const size = pngSize(right)
  const page = await browser.newPage({
    viewport: { width: size.width * 2 + 48, height: size.height + 60 },
    deviceScaleFactor: 1,
  })
  const leftSrc = left ? `data:image/png;base64,${left.toString('base64')}` : ''
  const rightSrc = `data:image/png;base64,${right.toString('base64')}`
  const oldBlock = left
    ? `<img alt="old ${name}" width="${size.width}" height="${size.height}" src="${leftSrc}">`
    : `<div style="width:${size.width}px;height:${size.height}px;background:rgb(247, 247, 246);display:flex;align-items:center;justify-content:center">added in this PR</div>`
  await page.setContent(`<!doctype html>
<html>
<body style="margin:0;background:white;font:16px sans-serif;color:rgb(28, 25, 23)">
  <div style="display:flex;gap:16px;padding:16px">
    <figure style="margin:0">
      <figcaption>old</figcaption>
      ${oldBlock}
    </figure>
    <figure style="margin:0">
      <figcaption>new</figcaption>
      <img alt="new ${name}" width="${size.width}" height="${size.height}" src="${rightSrc}">
    </figure>
  </div>
</body>
</html>`)
  await page.screenshot({
    path: join(outDir, name),
    fullPage: false,
    scale: 'css',
    animations: 'disabled',
  })
  await page.close()
}

async function main() {
  await mkdir(outDir, { recursive: true })
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const names = (await readdir(join(process.cwd(), 'tests/visual/baselines')))
    .filter((name) => name.endsWith('.png'))
    .sort()
  let changes = 0
  for (const name of names) {
    const rel = `tests/visual/baselines/${name}`
    const currentPath = join(process.cwd(), rel)
    let current: Buffer
    try {
      current = await readFile(currentPath)
    } catch {
      continue
    }
    const previous = gitShow(rel)
    const same = previous !== null && Buffer.compare(previous, current) === 0
    if (same) continue
    changes += 1
    await panel(browser, previous, current, name)
    console.log(`side_by_side ${name} old=${previous ? 'present' : 'added'}`)
  }
  await browser.close()
  await writeFile(
    join(outDir, 'changes.txt'),
    `changes=${changes}\nfrom=${fromRef}\nsha=${sha}\n`,
  )
  console.log(`baseline_side_by_side changes=${changes}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'side by side failed')
  process.exit(1)
})
