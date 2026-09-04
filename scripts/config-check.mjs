import { resolve } from 'node:path'
import { loadLocalApiKey } from './config.mjs'

const key = await loadLocalApiKey(
  resolve(process.env.DSH_DEBUG_CONFIG_PATH ?? resolve(process.cwd(), 'config.ini')),
)
console.log(`Local DeepSeek configuration is valid (key length: ${key.length}).`)
