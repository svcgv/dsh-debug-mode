import { defineConfig } from 'tsdown'
import type { TsdownPlugin } from 'tsdown'
import { toLoaderBundle } from './src/build/client-bundle.ts'

/**
 * Wrap the emitted browser chunk in the Harness loader handoff
 * (`window.__ModuleLoader__.load({ id, factory })`). The `/plugins` combo
 * route concatenates plugin client bundles into one classic script, so the
 * bundle must carry no top-level module syntax; the pure conversion lives in
 * `src/build/client-bundle.ts` and is unit-tested there.
 */
function harnessClientLoaderWrap(): TsdownPlugin {
  return {
    name: 'dsh-debug-mode:client-loader-wrap',
    renderChunk(code, chunk) {
      if (chunk.fileName !== 'client.js') return null
      return { code: toLoaderBundle(code), map: null }
    },
  }
}

export default defineConfig([
  {
    name: 'dsh-debug-mode-host',
    entry: { index: 'src/index.ts', host: 'src/host.ts' },
    outDir: 'lib',
    format: ['esm'],
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
  },
  {
    name: 'dsh-debug-mode-client',
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: ['esm'],
    fixedExtension: false,
    platform: 'browser',
    target: 'es2024',
    dts: true,
    clean: false,
    deps: {
      neverBundle: ['react', 'react/jsx-runtime'],
    },
    plugins: [harnessClientLoaderWrap()],
  },
])
