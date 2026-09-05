/**
 * Harness web client bundle shape.
 *
 * The Harness `/plugins` route concatenates every plugin's `client.js` into one
 * classic `<script>` response, so a bundle must not contain top-level
 * `import`/`export` statements — one ESM line would abort the whole script and
 * leave every plugin unregistered (the boot page reports "failed to load
 * plugins"). The loader contract instead expects each bundle to call
 *
 * ```ts
 * window.__ModuleLoader__.load({
 *   id: "<package-name>",
 *   factory: (require) => { /* CJS-shaped factory body *\/ },
 * });
 * ```
 *
 * `tsdown` emits clean ESM per entry; this module converts that chunk into the
 * loader factory body (head `import`s become `require` calls, the trailing
 * named-export list becomes `exports.*` assignments) and wraps it. The
 * conversion is a build-time string transform over rolldown's deterministic
 * output shape and is validated by parsing the result as a classic script.
 *
 * @module dsh-debug-mode/build/client-bundle
 */

import { parse } from '@babel/parser'

/** Loader registration id — the package name the boot manifest row uses. */
export const CLIENT_MODULE_ID = 'dsh-debug-mode'

/** One converted factory-body line, kept plain so the wrapper stays readable. */
const INDENT = '    '

interface LeadingImports {
  /** Converted `require` declarations, in source order. */
  requires: readonly string[]
  /** Remaining source lines after the leading import block. */
  rest: readonly string[]
}

interface TrailingExport {
  /** `exports.a = a;` assignments for the trailing named-export statement. */
  assignments: string
  /** Source without the trailing export statement. */
  body: string
}

/**
 * Convert one rolldown named-export statement (`export { a, b as c };`) into
 * CommonJS export assignments.
 * @param source - the full export statement text.
 * @returns one `exports.* = *;` line per exported binding.
 */
export function exportStatementToAssignments(source: string): string {
  const trimmed = source.trim()
  const match = /^export\s*\{\s*([\s\S]*?)\s*\}\s*;?\s*$/.exec(trimmed)
  if (match === null) {
    throw new Error(`unsupported client export statement: ${trimmed.slice(0, 120)}`)
  }
  const bindings = match[1]
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (bindings === undefined || bindings.length === 0) {
    throw new Error(`client export list is empty: ${trimmed.slice(0, 120)}`)
  }
  return bindings
    .map((binding) => {
      const rename = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding)
      if (rename !== null) return `exports.${rename[2]} = ${rename[1]};`
      if (/^[A-Za-z_$][\w$]*$/.test(binding)) return `exports.${binding} = ${binding};`
      throw new Error(`unsupported client export binding: ${binding}`)
    })
    .join('\n')
}

/** Normalize a quoted module specifier to a double-quoted JSON string. */
function quotedSpecifier(quoted: string): string {
  return JSON.stringify(quoted.slice(1, -1))
}

/** Parse one import binding list member into a destructure entry. */
function importBinding(binding: string): string {
  const trimmed = binding.trim()
  const rename = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed)
  if (rename !== null) return `${rename[1]}: ${rename[2]}`
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed
  throw new Error(`unsupported client import binding: ${binding}`)
}

/** Join a named-import list into a destructure-friendly member list. */
function namedImportList(text: string): string {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(importBinding)
    .join(', ')
}

/**
 * Convert one ESM import statement into `require` declarations that resolve
 * through the loader's injected factory `require`.
 * @param source - one full import statement (may span lines).
 * @param statementIndex - ordinal of this statement in the chunk, used to keep
 * default-import module refs distinct.
 * @returns one or more declaration lines.
 */
export function importStatementToRequires(source: string, statementIndex = 0): string {
  const statement = source.trim().replace(/\s+/g, ' ')

  // Side-effect only: `import "mod";`
  const sideEffect = /^import\s+(["'][^"']+["'])\s*;?$/.exec(statement)
  if (sideEffect !== null) return `require(${quotedSpecifier(sideEffect[1] ?? '')});`

  // Namespace only: `import * as ns from "mod";`
  const namespaceOnly =
    /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(["'][^"']+["'])\s*;?$/.exec(statement)
  if (namespaceOnly !== null) {
    return `const ${namespaceOnly[1]} = require(${quotedSpecifier(namespaceOnly[2] ?? '')});`
  }

  // Default + namespace: `import d, * as ns from "mod";`
  const defaultNamespace =
    /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(["'][^"']+["'])\s*;?$/.exec(
      statement,
    )
  if (defaultNamespace !== null) {
    const [, binding, ns, quoted] = defaultNamespace
    const moduleRef = requireBinding(quoted ?? '', statementIndex)
    return [
      moduleRef.declaration,
      defaultAssignment(binding ?? '', moduleRef.name),
      `const ${ns} = ${moduleRef.name};`,
    ].join('\n')
  }

  // Default + named: `import d, { a as b } from "mod";`
  const defaultNamed =
    /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*?)\}\s+from\s+(["'][^"']+["'])\s*;?$/.exec(
      statement,
    )
  if (defaultNamed !== null) {
    const [, binding, list, quoted] = defaultNamed
    const moduleRef = requireBinding(quoted ?? '', statementIndex)
    return [
      moduleRef.declaration,
      defaultAssignment(binding ?? '', moduleRef.name),
      `const { ${namedImportList(list ?? '')} } = ${moduleRef.name};`,
    ].join('\n')
  }

  // Named only: `import { a as b } from "mod";`
  const namedOnly = /^import\s*\{([\s\S]*?)\}\s+from\s+(["'][^"']+["'])\s*;?$/.exec(statement)
  if (namedOnly !== null) {
    const [, list, quoted] = namedOnly
    return `const { ${namedImportList(list ?? '')} } = require(${quotedSpecifier(quoted ?? '')});`
  }

  // Default only: `import d from "mod";`
  const defaultOnly = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'][^"']+["'])\s*;?$/.exec(statement)
  if (defaultOnly !== null) {
    const [, binding, quoted] = defaultOnly
    const moduleRef = requireBinding(quoted ?? '', statementIndex)
    return [moduleRef.declaration, defaultAssignment(binding ?? '', moduleRef.name)].join('\n')
  }

  throw new Error(`unsupported client import statement: ${source.trim().slice(0, 120)}`)
}

/**
 * Collect the leading import block of a rolldown ESM chunk and convert each
 * statement in order.
 * @param lines - chunk lines.
 * @returns the converted requires and the remaining lines.
 */
export function collectLeadingImports(lines: readonly string[]): LeadingImports {
  const requires: string[] = []
  let index = 0
  let statementIndex = 0
  while (index < lines.length && /^\s*import\s/.test(lines[index] ?? '')) {
    let statement = lines[index] ?? ''
    while (!/;\s*$/.test(statement) && index + 1 < lines.length) {
      index += 1
      statement += `\n${lines[index]}`
    }
    requires.push(importStatementToRequires(statement, statementIndex))
    statementIndex += 1
    index += 1
  }
  return { requires, rest: lines.slice(index) }
}

/**
 * Strip the trailing named-export statement from a converted chunk body.
 * @param text - chunk source after the import block was removed.
 * @returns the export assignments and the remaining body.
 */
export function stripTrailingExport(text: string): TrailingExport {
  const match = /\nexport\s*\{[\s\S]*?\}\s*;?\s*$/.exec(text)
  if (match === null) {
    const whole = /^export\s*\{[\s\S]*?\}\s*;?\s*$/.exec(text)
    if (whole === null) return { assignments: '', body: text }
    return { assignments: exportStatementToAssignments(whole[0]), body: '' }
  }
  const statement = match[0].replace(/^\nexport/, 'export')
  const body =
    `${text.slice(0, match.index)}\n${text.slice(match.index + match[0].length)}`.trimEnd()
  return { assignments: exportStatementToAssignments(statement), body: `${body}\n` }
}

/**
 * Convert a rolldown ESM client chunk into the loader factory body: head
 * imports become injected-`require` declarations and the trailing export list
 * becomes `exports.*` assignments.
 * @param code - the emitted ESM chunk.
 * @returns the factory body (without the loader call wrapper).
 */
export function convertClientChunkToFactoryBody(code: string): string {
  const { requires, rest } = collectLeadingImports(code.split('\n'))
  const { assignments, body } = stripTrailingExport(rest.join('\n'))
  const parts = [requires.join('\n'), body.trim(), assignments].filter((part) => part.length > 0)
  return parts.join('\n')
}

/**
 * Wrap a converted factory body in the Harness loader handoff.
 * @param body - CJS-shaped factory body.
 * @param moduleId - registration id; defaults to the package name.
 * @returns the complete bundle source.
 */
export function wrapClientFactory(body: string, moduleId: string = CLIENT_MODULE_ID): string {
  const indented = body
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${INDENT}${line}`))
    .join('\n')
  return [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(moduleId)},`,
    '  factory: (require) => {',
    "    'use strict';",
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    "    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });",
    indented,
    '    return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
}

/**
 * Full conversion pipeline used by the tsdown `renderChunk` hook: convert the
 * ESM chunk to a factory body, parse it as a classic script to fail loudly on
 * any leftover module syntax, and wrap it in the loader handoff.
 * @param code - emitted ESM chunk source.
 * @param moduleId - loader registration id.
 * @returns the final bundle source.
 */
export function toLoaderBundle(code: string, moduleId: string = CLIENT_MODULE_ID): string {
  const body = convertClientChunkToFactoryBody(code)
  try {
    parse(body, { sourceType: 'script' })
  } catch (error) {
    throw new Error(
      `client bundle still contains module syntax after loader conversion: ${String(error)}`,
      { cause: error },
    )
  }
  return wrapClientFactory(body, moduleId)
}

/** Shared helper for default-import interop against a module-table record. */
function requireBinding(quoted: string, index: number): { name: string; declaration: string } {
  const name = `__dsh_module_${index}`
  return { name, declaration: `const ${name} = require(${quoted});` }
}

/** Bind a default import with CJS/ESM interop against a module-table record. */
function defaultAssignment(binding: string, moduleRef: string): string {
  return `const ${binding} = ${moduleRef} && ${moduleRef}.__esModule ? ${moduleRef}.default : ${moduleRef};`
}
