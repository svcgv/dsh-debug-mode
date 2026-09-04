import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.shared.ts'

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ['tests/platform/**/*.spec.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
      maxWorkers: 1,
    },
  }),
)
