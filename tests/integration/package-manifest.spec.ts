import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name: string
  exports: Record<string, unknown>
  dsh: {
    bundle: { patch: string }
    client: { platform: string; inject: string[] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseManifest(text: string): PackageManifest {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.exports)) {
    throw new Error('package.json is missing its package identity or exports')
  }
  const dsh = value.dsh
  if (!isRecord(dsh) || !isRecord(dsh.bundle) || !isRecord(dsh.client)) {
    throw new Error('package.json is missing its dsh declarations')
  }
  if (
    typeof dsh.bundle.patch !== 'string' ||
    typeof dsh.client.platform !== 'string' ||
    !Array.isArray(dsh.client.inject) ||
    !dsh.client.inject.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('package.json has invalid dsh declarations')
  }
  return {
    name: value.name,
    exports: value.exports,
    dsh: {
      bundle: { patch: dsh.bundle.patch },
      client: { platform: dsh.client.platform, inject: dsh.client.inject },
    },
  }
}

describe('stage-one package manifest', () => {
  it('declares a bundle and browser entry without activating runtime rows', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const manifest = parseManifest(await readFile(resolve(root, 'package.json'), 'utf8'))
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('dsh-debug-mode')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client).toEqual({ platform: 'web', inject: [] })
    expect(patch.trimEnd().endsWith('[]')).toBe(true)
    expect(patch).not.toMatch(/^\s*-\s+id:\s+ui-plan\b/m)
  })
})
