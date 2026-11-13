import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const FILES = ['tests/visual/screens.spec.ts', 'scripts/visual-shots.ts']
const PLANTED = 'scripts/fixtures/fc2-planted-locators.txt'
const LOCATOR_END = /\.first\(\)|\.last\(\)/g

function hits(text: string) {
  return text.match(LOCATOR_END)?.length ?? 0
}

const plantedText = readFileSync(PLANTED, 'utf8')
const plantedHits = hits(plantedText)
if (process.argv[2] === 'planted') {
  const plantedHasFirst = plantedHits > 0
  console.log(`fc2_planted_locator_hits=${plantedHits}`)
  console.log(`fc2_planted_has_first=${plantedHasFirst}`)
  process.exit(plantedHasFirst ? 1 : 0)
}

let headHits = 0
for (const file of FILES) {
  headHits += hits(readFileSync(file, 'utf8'))
}

const mutated = `${readFileSync(FILES[0] ?? '', 'utf8')}\npage.locator('.err').first()\n`
const mutatedHits = hits(mutated)

console.log(`fc2_planted_locator_hits=${plantedHits}`)
console.log(`fc2_head_locator_hits=${headHits}`)
console.log(`fc2_planted_has_first=${plantedHits > 0}`)
console.log(`fc2_head_first_absent=${headHits === 0}`)
console.log(`fc2_mutated_hits=${mutatedHits}`)
console.log(`fc2_mutated_detected=${mutatedHits > 0}`)

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setContent(
  '<div class="err">Enter a valid email.</div><div class="err">Use at least 8 characters.</div>',
)
const unscoped = await page.locator('.err').count()
const exact = await page
  .getByText('Use at least 8 characters.', { exact: true })
  .count()
let firstSilent = false
try {
  // Planted sample behavior: .first() acts on one of two matches.
  await page.locator('.err').first().waitFor({ timeout: 1000 })
  firstSilent = true
} catch {
  firstSilent = false
}
let multiFails = false
try {
  await page.locator('.err').waitFor({ timeout: 1000 })
} catch (error) {
  const message = error instanceof Error ? error.message : ''
  multiFails = message.includes('strict mode violation')
}
let exactPasses = false
try {
  await page
    .getByText('Use at least 8 characters.', { exact: true })
    .waitFor({ timeout: 1000 })
  exactPasses = exact === 1
} catch {
  exactPasses = false
}
await browser.close()

console.log(`fc2_unscoped_count=${unscoped}`)
console.log(`fc2_exact_count=${exact}`)
console.log(`fc2_planted_first_silent=${firstSilent}`)
console.log(`fc2_multi_match_fails=${multiFails}`)
console.log(`fc2_exact_text_passes=${exactPasses}`)

if (
  plantedHits === 0 ||
  headHits !== 0 ||
  mutatedHits === 0 ||
  unscoped < 2 ||
  !firstSilent ||
  !multiFails ||
  !exactPasses
) {
  console.log('fc2=fail')
  process.exit(1)
}

console.log('fc2=pass')
