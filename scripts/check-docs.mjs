import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'docs/implementation-plan.md',
  'docs/architecture.md',
  'docs/coding-standards.md',
  'docs/testing-strategy.md',
  'docs/security-and-safety.md',
  'docs/adr/0001-standalone-bundle.md',
  'docs/adr/0002-debug-runtime-model.md',
]

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === 'node_modules' || entry.name === '.git') return []
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return markdownFiles(path)
      return extname(entry.name) === '.md' ? [path] : []
    }),
  )
  return nested.flat()
}

function relativeLinkTargets(text) {
  const targets = []
  let fenced = false
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (target === undefined || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue
      }
      const relative = decodeURIComponent(target.split('#', 1)[0] ?? '')
      if (relative !== '') targets.push({ index, relative, target })
    }
  }
  return targets
}

async function brokenLinks(file) {
  const text = await readFile(file, 'utf8')
  return (
    await Promise.all(
      relativeLinkTargets(text).map(async ({ index, relative, target }) => {
        try {
          await access(resolve(dirname(file), relative))
          return undefined
        } catch {
          return `${file.slice(root.length + 1)}:${index + 1} -> ${target}`
        }
      }),
    )
  ).filter((entry) => entry !== undefined)
}

await Promise.all(required.map((path) => access(resolve(root, path))))
const broken = (await Promise.all((await markdownFiles(root)).map(brokenLinks))).flat()

if (broken.length > 0) {
  throw new Error(`Broken documentation links:\n${broken.join('\n')}`)
}

console.log(`Documentation check passed (${required.length} required files).`)
