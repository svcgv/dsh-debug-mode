/**
 * Statement-level probe instrumentation for JavaScript and TypeScript
 * sources. The transform parses once, selects executable statements inside
 * the located line range, and splices one probe statement before each
 * selected node while preserving every original byte outside the splices.
 * Generated statements are deterministic and carry the run id so cleanup can
 * prove ownership before removing them.
 *
 * @module dsh-debug-mode/instrumentation/js
 */

import { parse, type ParserPlugin } from '@babel/parser'
import traverse from '@babel/traverse'
import { extname } from 'node:path'

/** Marker prefix embedded in generated runtime imports. */
export const RUNTIME_IMPORT_MARKER = '__dsh_trace_import'

/** Probe helper name injected by instrumentation. */
export const PROBE_HELPER = 'globalThis.__dshTraceProbe'

/** One textual splice to apply. */
export interface JsSplice {
  readonly offset: number
  readonly text: string
}

/** Options for instrumenting one source file. */
export interface InstrumentJsOptions {
  readonly runId: string
  /** Project-relative path used inside probe metadata. */
  readonly projectPath: string
  readonly startLine: number
  readonly endLine: number
  /** Cap on generated probes per file (safety bound). */
  readonly maxProbes?: number
}

/** Result of instrumenting one source file. */
export interface InstrumentJsResult {
  readonly code: string
  readonly probes: number
  readonly skipped: number
}

/** Minimal statement view the transform relies on. */
interface StatementView {
  readonly type: string
  readonly start: number
  readonly loc: { readonly start: { readonly line: number } }
}

interface WalkPath {
  readonly node: StatementView
  readonly parentPath?: WalkPath | null
}

const DEFAULT_MAX_PROBES = 120

/** One parsed program kept as an opaque AST plus its program body. */
export interface ParsedJavaScript {
  /** Full babel File node used as the traversal root. */
  readonly ast: unknown
  /** Structural view of the program for line/type filtering. */
  readonly program: { readonly type: string }
}

/** Parse one source with the right syntax plugins for its extension. */
export function parseJavaScript(source: string, filePath: string): ParsedJavaScript {
  const extension = extname(filePath).toLowerCase()
  const plugins: ParserPlugin[] = []
  if (extension === '.ts' || extension === '.mts' || extension === '.cts' || extension === '.tsx')
    plugins.push('typescript')
  if (extension === '.tsx' || extension === '.jsx') plugins.push('jsx')
  const result = parse(source, {
    sourceType: 'unambiguous',
    sourceFilename: filePath,
    plugins,
    errorRecovery: false,
  })
  return { ast: result, program: result.program }
}

function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  let indent = ''
  for (let index = lineStart; index < offset; index += 1) {
    const char = source[index]
    if (char !== ' ' && char !== '\t') break
    indent += char
  }
  return indent
}

function probeLine(runId: string, projectPath: string, line: number, kind: string): string {
  return `${PROBE_HELPER}&&${PROBE_HELPER}({r:${JSON.stringify(runId)},p:${JSON.stringify(projectPath)},l:${line},k:${JSON.stringify(kind)}});`
}

const INSTRUMENTABLE_STATEMENT_TYPES = new Set([
  'ExpressionStatement',
  'VariableDeclaration',
  'ReturnStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'TryStatement',
  'ThrowStatement',
  'BreakStatement',
  'ContinueStatement',
  'LabeledStatement',
  'WithStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
])

/** Select executable statements whose start line lies in the target range. */
function collectProbeSites(
  program: unknown,
  startLine: number,
  endLine: number,
): Array<{ offset: number; line: number }> {
  const selected: Array<{ offset: number; line: number }> = []
  const visitor = {
    enter(path: WalkPath): void {
      const node = path.node
      if (!INSTRUMENTABLE_STATEMENT_TYPES.has(node.type)) return
      const start = node.start
      const line = node.loc.start.line
      if (line < startLine || line > endLine) return
      const parentType = path.parentPath?.node.type
      if (
        parentType === 'IfStatement' ||
        parentType === 'ForStatement' ||
        parentType === 'ForInStatement' ||
        parentType === 'ForOfStatement' ||
        parentType === 'WhileStatement' ||
        parentType === 'DoWhileStatement'
      ) {
        return
      }
      selected.push({ offset: start, line })
    },
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural traversal wrapper around babel's typed visitor
  ;(traverse as unknown as (target: unknown, options: { enter(path: WalkPath): void }) => void)(
    program,
    visitor,
  )
  return selected
}

/**
 * Instrument one source file. Returns the modified code plus probe counts.
 * Throws a typed error when the source cannot be parsed.
 */
export function instrumentJavaScript(
  source: string,
  options: InstrumentJsOptions,
): InstrumentJsResult {
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES
  let parsed: ParsedJavaScript
  try {
    parsed = parseJavaScript(source, options.projectPath)
  } catch (error) {
    throw new Error(`cannot parse ${options.projectPath}: ${String(error)}`, { cause: error })
  }
  const sites = collectProbeSites(parsed.ast, options.startLine, options.endLine)
  const selectedSites = sites.length > maxProbes ? sites.slice(0, maxProbes) : sites
  const splices: JsSplice[] = []
  for (const site of selectedSites) {
    const indent = indentOf(source, site.offset)
    const text = `\n${indent}${probeLine(options.runId, options.projectPath, site.line, 's')}`
    splices.push({ offset: site.offset, text })
  }
  const skipped = sites.length - selectedSites.length
  const sorted = [...splices].toSorted((a, b) => b.offset - a.offset)
  let code = source
  for (const splice of sorted) {
    code = `${code.slice(0, splice.offset)}${splice.text}${code.slice(splice.offset)}`
  }
  return { code, probes: splices.length, skipped }
}

/** Remove every generated probe and runtime-import line owned by one run. */
export function removeInstrumentation(
  source: string,
  runId: string,
): { code: string; removed: number } {
  const probeHead = `${PROBE_HELPER}&&${PROBE_HELPER}({r:${JSON.stringify(runId)},`
  const escapedHead = probeHead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\n[ \t]*${escapedHead}[^\n]*;`, 'g')
  const probeMatches = source.match(pattern)
  const removedProbes = probeMatches?.length ?? 0
  const withoutProbes = source.replace(pattern, '')
  const kept: string[] = []
  let removed = removedProbes
  for (const line of withoutProbes.split('\n')) {
    if (line.includes(`${RUNTIME_IMPORT_MARKER}:${runId}`)) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  return { code: kept.join('\n'), removed }
}

/**
 * Prepend a runtime import to a module source. Classic scripts (no import or
 * export syntax) are left untouched because adding an import would change
 * their execution model.
 */
export function addRuntimeImport(
  source: string,
  runtimeRelativePath: string,
  runId: string,
): { code: string; changed: boolean } {
  if (!/\b(import|export)\b/.test(source)) return { code: source, changed: false }
  const importLine = `import ${JSON.stringify(runtimeRelativePath)}; // ${RUNTIME_IMPORT_MARKER}:${runId}\n`
  return { code: `${importLine}${source}`, changed: true }
}
