/**
 * Dart/Flutter statement-level probe instrumentation. Dart has no lightweight
 * in-process AST parser dependency in this bundle, so instrumentation is
 * deliberately conservative: only function-entry lines and single-line
 * `return`/`throw` statements inside the located range are probed, and every
 * candidate is validated with local heuristics before a splice. Unsure lines
 * are left untouched rather than risking a broken Dart file.
 *
 * @module dsh-debug-mode/instrumentation/dart
 */

/** Marker prefix embedded in generated runtime imports. */
export const DART_RUNTIME_MARKER = 'dsh_trace_import'

/** Generate the trace runtime library content for one run. */
export function createDartRuntimeSource(runId: string, endpoint: string, token: string): string {
  return [
    "import 'dart:convert';",
    "import 'dart:io';",
    '',
    'final String _dshRunId = ' + JSON.stringify(runId) + ';',
    'final String _dshToken = ' + JSON.stringify(token) + ';',
    'final String _dshEndpoint = ' + JSON.stringify(endpoint) + ';',
    '',
    '/// Send one bounded trace event to the debug listener without throwing.',
    'Future<void> trace(Map<String, Object?> meta) async {',
    '  try {',
    '    final client = HttpClient();',
    '    final request = await client.postUrl(Uri.parse(_dshEndpoint));',
    '    request.headers.contentType = ContentType.json;',
    '    meta["runId"] = _dshRunId;',
    '    meta["token"] = _dshToken;',
    '    meta["ts"] = DateTime.now().millisecondsSinceEpoch;',
    '    request.write(jsonEncode(meta));',
    '    final response = await request.close();',
    '    await response.drain<void>();',
    '    client.close();',
    '  } catch (_) {',
    '    // Trace failures must never break the app under debug.',
    '  }',
    '}',
    '',
  ].join('\n')
}

function indentation(line: string): string {
  let indent = ''
  for (const char of line) {
    if (char !== ' ' && char !== '\t') break
    indent += char
  }
  return indent
}

/** Whether a line is blank or a comment. */
export function isSkippableDartLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  )
}

/** Whether a single line is a function opening with a brace (conservative). */
export function looksLikeFunctionOpen(line: string): boolean {
  if (isSkippableDartLine(line)) return false
  if (!line.includes('{')) return false
  const trimmed = line.trim()
  if (
    trimmed.startsWith('if ') ||
    trimmed.startsWith('for ') ||
    trimmed.startsWith('while ') ||
    trimmed.startsWith('switch ') ||
    trimmed.startsWith('try') ||
    trimmed.startsWith('class ') ||
    trimmed.startsWith('enum ')
  ) {
    return false
  }
  // Requires `name(args)` before the brace and at least one non-keyword token.
  return /\([^)]*\)\s*\{/.test(trimmed)
}

/** Whether a single-line statement is safe to probe before. */
export function isSafeStatementLine(line: string): boolean {
  const trimmed = line.trim()
  if (isSkippableDartLine(line)) return false
  if (!trimmed.endsWith(';')) return false
  return trimmed.startsWith('return ') || trimmed.startsWith('throw ')
}

/** One text splice to apply. */
export interface DartSplice {
  readonly offset: number
  readonly text: string
}

/** Instrument one Dart source conservatively. */
export function instrumentDart(
  source: string,
  options: {
    runId: string
    projectPath: string
    startLine: number
    endLine: number
    maxProbes?: number
  },
): { code: string; probes: number } {
  const maxProbes = options.maxProbes ?? 120
  const splices: DartSplice[] = []
  let probes = 0
  let lineNumber = 1
  let runningOffset = 0
  for (const line of source.split('\n')) {
    if (probes < maxProbes && lineNumber >= options.startLine && lineNumber <= options.endLine) {
      const trimmed = line.trim()
      const indent = indentation(line)
      if (looksLikeFunctionOpen(line) || isSafeStatementLine(line)) {
        const braceOffset = line.indexOf('{')
        const anchor = braceOffset === -1 ? line.length - line.trimEnd().length : braceOffset + 1
        const kind = trimmed.startsWith('return') || trimmed.startsWith('throw') ? 's' : 'e'
        const meta = JSON.stringify({
          r: options.runId,
          f: options.projectPath,
          l: lineNumber,
          k: kind,
        })
        const probe = `${indent}dsh.trace(${meta});\n`
        splices.push({ offset: runningOffset + anchor, text: probe })
        probes += 1
      }
    }
    runningOffset += line.length + 1
    lineNumber += 1
  }
  const sorted = [...splices].toSorted((a, b) => b.offset - a.offset)
  let code = source
  for (const splice of sorted) {
    code = `${code.slice(0, splice.offset)}${splice.text}${code.slice(splice.offset)}`
  }
  return { code, probes }
}

/** Prepend the runtime import and drop a generated marker comment. */
export function addDartRuntimeImport(source: string, importPath: string, runId: string): string {
  return `import '${importPath}'; // ${DART_RUNTIME_MARKER}:${runId}\n${source}`
}

/** Remove dart probes and runtime imports owned by one run. */
export function removeDartInstrumentation(
  source: string,
  runId: string,
): { code: string; removed: number } {
  const importMarker = `// ${DART_RUNTIME_MARKER}:${runId}`
  const probeMarker = `"r":${JSON.stringify(runId)}`
  const kept: string[] = []
  let removed = 0
  for (const line of source.split('\n')) {
    if (
      line.includes(importMarker) ||
      (line.includes('dsh.trace(') && line.includes(probeMarker))
    ) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  return { code: kept.join('\n'), removed }
}
