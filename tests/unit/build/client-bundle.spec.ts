import { describe, expect, it } from 'vitest'
import {
  CLIENT_MODULE_ID,
  collectLeadingImports,
  convertClientChunkToFactoryBody,
  exportStatementToAssignments,
  importStatementToRequires,
  stripTrailingExport,
  toLoaderBundle,
  wrapClientFactory,
} from '../../../src/build/client-bundle.ts'

describe('exportStatementToAssignments', () => {
  it('maps a plain named-export list to export assignments', () => {
    expect(exportStatementToAssignments('export { apply, inject };')).toBe(
      'exports.apply = apply;\nexports.inject = inject;',
    )
  })

  it('honours renamed bindings', () => {
    expect(exportStatementToAssignments('export { internal as public };\n')).toBe(
      'exports.public = internal;',
    )
  })

  it('rejects unsupported export shapes loudly', () => {
    expect(() => exportStatementToAssignments('export default 1;')).toThrow(/unsupported/)
    expect(() => exportStatementToAssignments('export {};')).toThrow(/empty/)
  })
})

describe('importStatementToRequires', () => {
  it('converts a single named import', () => {
    expect(importStatementToRequires('import { useState } from "react";')).toBe(
      'const { useState } = require("react");',
    )
  })

  it('converts renamed named imports into a destructure', () => {
    expect(
      importStatementToRequires("import { jsx, jsxs as _jsxs } from 'react/jsx-runtime';"),
    ).toBe('const { jsx, jsxs: _jsxs } = require("react/jsx-runtime");')
  })

  it('converts a namespace import', () => {
    expect(importStatementToRequires('import * as ns from "mod";')).toBe(
      'const ns = require("mod");',
    )
  })

  it('converts a default import with CJS interop', () => {
    expect(importStatementToRequires('import d from "mod";')).toBe(
      'const __dsh_module_0 = require("mod");\n' +
        'const d = __dsh_module_0 && __dsh_module_0.__esModule ? __dsh_module_0.default : __dsh_module_0;',
    )
  })

  it('converts default plus named imports', () => {
    expect(importStatementToRequires('import d, { a as b } from "mod";')).toBe(
      'const __dsh_module_0 = require("mod");\n' +
        'const d = __dsh_module_0 && __dsh_module_0.__esModule ? __dsh_module_0.default : __dsh_module_0;\n' +
        'const { a: b } = __dsh_module_0;',
    )
  })

  it('converts default plus namespace imports', () => {
    expect(importStatementToRequires('import d, * as ns from "mod";')).toBe(
      'const __dsh_module_0 = require("mod");\n' +
        'const d = __dsh_module_0 && __dsh_module_0.__esModule ? __dsh_module_0.default : __dsh_module_0;\n' +
        'const ns = __dsh_module_0;',
    )
  })

  it('converts a side-effect import', () => {
    expect(importStatementToRequires('import "./styles.css";')).toBe('require("./styles.css");')
  })

  it('rejects unsupported import shapes loudly', () => {
    expect(() => importStatementToRequires('import { a b } from "m";')).toThrow(/unsupported/)
  })

  it('keeps per-statement module refs distinct for repeated default imports', () => {
    const first = importStatementToRequires('import a from "m";', 0)
    const second = importStatementToRequires('import b from "m";', 1)
    expect(first).toContain('__dsh_module_0')
    expect(second).toContain('__dsh_module_1')
  })
})

describe('collectLeadingImports', () => {
  it('consumes only the leading import block', () => {
    const lines = [
      'import { a } from "m";',
      "import * as ns from 'n';",
      '',
      '//#region src/x.ts',
      'const a = 1;',
    ]
    const result = collectLeadingImports(lines)
    expect(result.requires).toHaveLength(2)
    expect(result.rest.join('\n')).toContain('const a = 1;')
    expect(result.rest.join('\n')).not.toContain('import ')
  })

  it('returns an empty require list when the chunk starts with code', () => {
    const result = collectLeadingImports(['function a() {}'])
    expect(result.requires).toEqual([])
    expect(result.rest).toEqual(['function a() {}'])
  })
})

describe('stripTrailingExport', () => {
  it('removes the trailing export statement', () => {
    const result = stripTrailingExport('const a = 1;\nexport { a };\n')
    expect(result.assignments).toBe('exports.a = a;')
    expect(result.body).toContain('const a = 1;')
    expect(result.body).not.toContain('export ')
  })

  it('handles an export-only body', () => {
    const result = stripTrailingExport('export { a };')
    expect(result.assignments).toBe('exports.a = a;')
    expect(result.body).toBe('')
  })

  it('leaves a body without a trailing export unchanged', () => {
    const result = stripTrailingExport('const a = 1;')
    expect(result.assignments).toBe('')
    expect(result.body).toBe('const a = 1;')
  })
})

describe('convertClientChunkToFactoryBody', () => {
  it('produces a CJS-shaped factory body with no module syntax', () => {
    const chunk = [
      'import { useState } from "react";',
      'import { jsx, jsxs } from "react/jsx-runtime";',
      '',
      'function apply(ctx) { return ctx; }',
      'export { apply, name };',
      '',
    ].join('\n')
    const body = convertClientChunkToFactoryBody(chunk)
    expect(body).toContain('const { useState } = require("react");')
    expect(body).toContain('const { jsx, jsxs } = require("react/jsx-runtime");')
    expect(body).toContain('exports.apply = apply;')
    expect(body).toContain('exports.name = name;')
    expect(body).not.toMatch(/^\s*import\s/)
    expect(body).not.toMatch(/^\s*export\s/)
  })
})

describe('wrapClientFactory', () => {
  it('wraps a body in the module loader handoff with the package id', () => {
    const wrapped = wrapClientFactory('exports.a = a;')
    expect(wrapped).toContain('window.__ModuleLoader__.load({')
    expect(wrapped).toContain(`id: ${JSON.stringify(CLIENT_MODULE_ID)}`)
    expect(wrapped).toContain('factory: (require) => {')
    expect(wrapped).toContain('var module = { exports: {} };')
    expect(wrapped).toContain('exports.a = a;')
    expect(wrapped).toContain('return module.exports;')
  })

  it('supports an explicit registration id', () => {
    expect(wrapClientFactory('', 'other-plugin')).toContain('id: "other-plugin"')
  })
})

describe('toLoaderBundle', () => {
  it('converts and wraps a realistic rolldown ESM chunk', () => {
    const chunk = [
      'import { useState } from "react";',
      'import { jsx } from "react/jsx-runtime";',
      '//#region src/client/ui.tsx',
      'function ModeControl() { return jsx("span"); }',
      '//#endregion',
      'const name = "dsh-debug-mode-client";',
      'export { ModeControl, name };',
      '',
    ].join('\n')
    const bundle = toLoaderBundle(chunk)
    expect(bundle).toMatch(/^window\.__ModuleLoader__\.load\(\{/)
    expect(bundle).toContain('const { useState } = require("react");')
    expect(bundle).toContain('exports.ModeControl = ModeControl;')
    expect(bundle).toMatch(/\}\);\s*$/)
    expect(bundle).not.toContain('\nimport ')
    expect(bundle).not.toContain('\nexport ')
  })

  it('fails loudly when module syntax survives conversion', () => {
    const chunk = 'const a = 1;\nexport default a;\n'
    expect(() => toLoaderBundle(chunk)).toThrow(/still contains module syntax/)
  })
})
