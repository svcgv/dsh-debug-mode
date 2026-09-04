import { defineConfig } from 'tsdown'

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
      neverBundle: ['react'],
    },
  },
])
