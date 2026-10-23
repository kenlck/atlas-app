import { defineConfig } from '@playwright/test'

const pinned =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea'

export default defineConfig({
  testDir: 'tests/visual',
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/baselines/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180000,
  use: {
    baseURL: process.env.BASE_URL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    timezoneId: 'UTC',
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  metadata: {
    pinnedPlaywrightImage: pinned,
  },
})
