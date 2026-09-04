import { defineConfig } from 'vitest/config'

export const sharedTestConfig = defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
