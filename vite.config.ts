import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// The panel UI. `pnpm panel` builds it into dist/ui; `pnpm panel:dev` serves it with hot reload.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  build: { outDir: '../dist/ui', emptyOutDir: true },
})
