import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Excalidraw touches window at import. Keep it out of the server graph so
  // doc pages and sign-in do not evaluate it.
  ssr: { external: ['@excalidraw/excalidraw'] },
  plugins: [
    devtools(),
    nitro({
      preset: 'node-server',
      plugins: ['src/server/production-env.ts'],
      rollupConfig: { external: [/^@sentry\//, '@excalidraw/excalidraw'] },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
