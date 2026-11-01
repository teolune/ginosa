import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve('src/engine'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The persistent module cache keys on file contents, so src/effects/registry.ts kept
    // an old list of effect folders after a new one was added (import.meta.glob). Off.
    fsModuleCache: false
  }
})
