import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'linux', 'win32'])

describe('platform test lane', () => {
  it('runs on a supported host and owns its temporary files', async () => {
    expect(SUPPORTED_PLATFORMS.has(process.platform)).toBe(true)

    const directory = await mkdtemp(join(tmpdir(), 'dsh-debug-mode-'))
    const file = join(directory, 'probe.txt')
    try {
      await writeFile(file, 'stage-one\n', 'utf8')
      await expect(readFile(file, 'utf8')).resolves.toBe('stage-one\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
