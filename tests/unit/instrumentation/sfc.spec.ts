import { describe, expect, it } from 'vitest'
import {
  extractScriptBlock,
  instrumentComponent,
  removeComponentInstrumentation,
} from '../../../src/instrumentation/sfc.ts'

const VUE = [
  '<template><div>{{ count }}</div></template>',
  '',
  '<script lang="ts">',
  'export function calc(n: number): number {',
  '  const y = n * 2',
  '  if (y > 2) {',
  '    return y',
  '  }',
  '  return 0',
  '}',
  '</script>',
  '',
  '<style>.card { color: red; }</style>',
  '',
].join('\n')

describe('single-file component instrumentation', () => {
  it('extracts a TypeScript script block with offsets', () => {
    const block = extractScriptBlock(VUE)
    expect(block?.lang).toBe('ts')
    expect(block?.content).toContain('export function calc')
    if (block !== undefined) {
      expect(VUE.slice(block.startOffset, block.endOffset)).toBe(block.content)
    }
  })

  it('normalizes svelte and jsx language attributes', () => {
    const svelte = '<script context="module" lang="typescript">const x = 1</script>\n'
    expect(extractScriptBlock(svelte)?.lang).toBe('ts')
    const jsx = '<script lang="tsx">export const el = <div /></script>'
    expect(extractScriptBlock(jsx)?.lang).toBe('tsx')
    const plain = '<script>\nlet count = 0\n</script>'
    expect(extractScriptBlock(plain)?.lang).toBe('js')
  })

  it('instruments only the script content and keeps template and styles', () => {
    const result = instrumentComponent(
      VUE,
      'src/Counter.vue',
      { runId: 'sfc-run', projectPath: 'src/Counter.vue', startLine: 4, endLine: 8 },
      '.dsh-debug/sfc-run/trace-runtime.js',
    )
    expect(result.probes).toBeGreaterThanOrEqual(3)
    expect(result.code).toContain('__dshTraceProbe')
    expect(result.code).toContain('.dsh-debug/sfc-run/trace-runtime.js')
    expect(result.code).toContain('<template><div>{{ count }}</div></template>')
    expect(result.code).toContain('.card { color: red; }')

    const cleaned = removeComponentInstrumentation(result.code, 'sfc-run')
    expect(cleaned.removed).toBeGreaterThan(0)
    expect(cleaned.code).not.toContain('__dshTraceProbe')
    expect(cleaned.code).toContain('<template>')
    expect(cleaned.code).toContain('.card { color: red; }')
  })

  it('instruments plain and tsx component scripts through synthetic paths', () => {
    const svelteJs = '<script>\nlet count = 0\nif (count > 0) {\n  count += 1\n}\n</script>\n'
    const jsResult = instrumentComponent(
      svelteJs,
      'Counter.svelte',
      { runId: 'js-run', projectPath: 'Counter.svelte', startLine: 1, endLine: 10 },
      'rt.js',
    )
    expect(jsResult.changed).toBe(true)
    expect(jsResult.code).toContain('__dshTraceProbe')

    const tsx = '<script lang="tsx">\nexport const el = <div a={1} />\n</script>\n'
    const tsxResult = instrumentComponent(
      tsx,
      'Box.vue',
      { runId: 'tsx-run', projectPath: 'Box.vue', startLine: 1, endLine: 10 },
      'rt.js',
    )
    expect(tsxResult.changed).toBe(true)

    const singleQuote = "<script lang='ts'>const x = 1</script>\n"
    expect(extractScriptBlock(singleQuote)?.lang).toBe('ts')

    const jsx = '<script lang="jsx">\nexport const el = <span>{1}</span>\n</script>\n'
    const jsxResult = instrumentComponent(
      jsx,
      'Panel.vue',
      { runId: 'jsx-run', projectPath: 'Panel.vue', startLine: 1, endLine: 10 },
      'rt.js',
    )
    expect(jsxResult.changed).toBe(true)
  })

  it('handles missing close tags and removal with no markers', () => {
    expect(extractScriptBlock('<script>const x = 1')).toBeUndefined()
    const untouched = removeComponentInstrumentation(VUE, 'no-such-run')
    expect(untouched.removed).toBe(0)
    expect(untouched.code).toBe(VUE)
  })

  it('returns the source unchanged when no script block exists', () => {
    expect(
      instrumentComponent(
        '<template>hi</template>',
        'a.vue',
        { runId: 'r', projectPath: 'a.vue', startLine: 1, endLine: 2 },
        'rt.js',
      ).changed,
    ).toBe(false)
    expect(removeComponentInstrumentation('<template>hi</template>', 'r').removed).toBe(0)
  })
})
