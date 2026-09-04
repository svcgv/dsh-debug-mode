import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadLocalApiKey } from './config.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const harness = resolve(process.env.DSH_HARNESS_DIR ?? resolve(root, '../deepseek-harness'))
const devRoot = resolve(root, '.dev')
const dshHome = resolve(devRoot, 'dsh-home')
const tarballs = resolve(devRoot, 'tarballs')
const key = await loadLocalApiKey(
  resolve(process.env.DSH_DEBUG_CONFIG_PATH ?? resolve(root, 'config.ini')),
)

await mkdir(tarballs, { recursive: true })
for (const entry of await readdir(tarballs)) {
  if (entry.endsWith('.tgz')) await rm(resolve(tarballs, entry))
}

await run('pnpm', ['pack', '--pack-destination', tarballs], root, {})
const tarball = (await readdir(tarballs)).find((entry) => entry.endsWith('.tgz'))
if (tarball === undefined) throw new Error('pnpm pack did not produce a tarball')
const packagePath = resolve(tarballs, tarball)
const env = { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: key }

// The profile is local to .dev/. Removing then adding gives the current source
// package a fresh install without touching the user's normal Harness profile.
await run(
  'pnpm',
  ['dsh', 'plugin', '--profile', 'web', 'remove', 'dsh-debug-mode'],
  harness,
  env,
  true,
)
await run('pnpm', ['dsh', 'plugin', '--profile', 'web', 'add', packagePath], harness, env)
await run('pnpm', ['dsh', '--profile', 'web', '--no-open', ...process.argv.slice(2)], harness, env)

function run(command, args, cwd, childEnv, allowFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0 || allowFailure) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}
