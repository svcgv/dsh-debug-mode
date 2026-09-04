import { execFileSync } from 'node:child_process'

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
const result = JSON.parse(output)
if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.files)) {
  throw new Error('npm pack returned an unexpected manifest')
}

const files = new Set(result[0].files.map((entry) => entry.path))
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client.d.ts',
]
const forbiddenPrefixes = ['src/', 'tests/', 'coverage/', '.dev/', '.github/']
const missing = required.filter((path) => !files.has(path))
const forbidden = [...files].filter((path) =>
  forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
)

if (missing.length > 0 || forbidden.length > 0) {
  throw new Error(
    [
      missing.length > 0 ? `Missing package files: ${missing.join(', ')}` : '',
      forbidden.length > 0 ? `Forbidden package files: ${forbidden.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

console.log(`Package check passed (${files.size} files).`)
