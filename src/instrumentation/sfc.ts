/**
 * Vue and Svelte single-file component instrumentation: locates the first
 * `<script>` block, instruments its content with the JS/TS probe engine, and
 * splices the result back without touching the template or styles.
 *
 * @module dsh-debug-mode/instrumentation/sfc
 */

import { extname } from 'node:path'
import {
  addRuntimeImport,
  instrumentJavaScript,
  removeInstrumentation,
  type InstrumentJsOptions,
} from './js.ts'

/** One extracted script block. */
export interface SfcScriptBlock {
  readonly lang: 'ts' | 'tsx' | 'js' | 'jsx'
  /** Content between the opening and closing script tags. */
  readonly content: string
  /** Offset of the content start inside the original source. */
  readonly startOffset: number
  /** Offset of the content end inside the original source. */
  readonly endOffset: number
}

const SCRIPT_OPEN = /<script\b[^>]*>/i

/** Extract the first script block of a Vue or Svelte component. */
export function extractScriptBlock(source: string): SfcScriptBlock | undefined {
  const openMatch = SCRIPT_OPEN.exec(source)
  if (openMatch === null) return undefined
  const closeTag = `</script>`
  const closeIndex = source.toLowerCase().indexOf(closeTag, openMatch.index + openMatch[0].length)
  if (closeIndex === -1) return undefined
  const startOffset = openMatch.index + openMatch[0].length
  const endOffset = closeIndex
  const attrs = openMatch[0]
  const langRaw = /lang="([^"]+)"/.exec(attrs)?.[1] ?? /lang='([^']+)'/.exec(attrs)?.[1] ?? 'js'
  const lang = normalizeLang(langRaw)
  return {
    lang,
    content: source.slice(startOffset, endOffset),
    startOffset,
    endOffset,
  }
}

function normalizeLang(raw: string): SfcScriptBlock['lang'] {
  if (raw === 'ts' || raw === 'typescript') return 'ts'
  if (raw === 'tsx') return 'tsx'
  if (raw === 'jsx') return 'jsx'
  return 'js'
}

/** Instrument one component file, replacing only its script content. */
export function instrumentComponent(
  source: string,
  filePath: string,
  options: Omit<InstrumentJsOptions, 'parserPath'> & { parserPath?: string },
  runtimeRelativePath: string,
): { code: string; probes: number; changed: boolean } {
  const block = extractScriptBlock(source)
  if (block === undefined) return { code: source, probes: 0, changed: false }
  const parserPath = options.parserPath ?? syntheticPath(filePath, block.lang)
  const instrumented = instrumentJavaScript(block.content, {
    ...options,
    parserPath,
  })
  // Component script blocks are compiled as modules by the bundler, so the
  // runtime import is safe to force even without an explicit import/export.
  const withImport = addRuntimeImport(instrumented.code, runtimeRelativePath, options.runId, true)
  const code = `${source.slice(0, block.startOffset)}${withImport.code}${source.slice(block.endOffset)}`
  return { code, probes: instrumented.probes, changed: instrumented.probes > 0 }
}

/** Remove component instrumentation spliced by this module. */
export function removeComponentInstrumentation(
  source: string,
  runId: string,
): { code: string; removed: number } {
  const block = extractScriptBlock(source)
  if (block === undefined) return { code: source, removed: 0 }
  const cleaned = removeInstrumentation(block.content, runId)
  if (cleaned.removed === 0) return { code: source, removed: 0 }
  const code = `${source.slice(0, block.startOffset)}${cleaned.code}${source.slice(block.endOffset)}`
  return { code, removed: cleaned.removed }
}

function syntheticPath(filePath: string, lang: SfcScriptBlock['lang']): string {
  const extension = extname(filePath)
  const base = filePath.slice(0, filePath.length - extension.length)
  if (lang === 'ts') return `${base}.ts`
  if (lang === 'tsx') return `${base}.tsx`
  if (lang === 'jsx') return `${base}.jsx`
  return `${base}.js`
}
