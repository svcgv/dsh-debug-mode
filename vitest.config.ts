import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.shared.ts'

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ['tests/unit/**/*.spec.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.types.ts'],
        reporter: ['text', 'json-summary', 'html'],
        thresholds: {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
          'src/{mode,run,instrumentation,listener,debugger,process,recovery}/**/*.{ts,tsx}': {
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
          },
        },
      },
    },
  }),
)
