import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'

/** Plasmo `url:` imports resolve at build time; stub them for Vitest. */
function plasmoUrlImportStub(): Plugin {
  const VIRTUAL_PREFIX = '\0plasmo-url:'
  return {
    name: 'plasmo-url-import-stub',
    resolveId(id) {
      if (id.startsWith('url:')) {
        return VIRTUAL_PREFIX + id.slice('url:'.length)
      }
      return null
    },
    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        return 'export default "/inpage.js"'
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [plasmoUrlImportStub()],
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
    exclude: ['**/build/**', '**/.plasmo/**', '**/dist/**'],
  },
})
