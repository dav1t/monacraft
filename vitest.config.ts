import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // node:sqlite prints an ExperimentalWarning on Node 22; it is expected noise.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
})
