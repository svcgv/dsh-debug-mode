import { readFile } from 'node:fs/promises'

/** Parse a minimal local INI document without logging credential values. */
export function parseIni(text) {
  const values = new Map()
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)]$/.exec(line)
    if (header !== null) {
      section = header[1] ?? ''
      continue
    }
    const match = /^([^=]+)=(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]?.trim()
    const value = match[2]?.trim()
    if (key === undefined || value === undefined) continue
    values.set(`${section}.${key}`, value)
  }
  return values
}

/** Read the local DeepSeek key from config.ini and fail without revealing it. */
export async function loadLocalApiKey(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(
      `Could not read local configuration at ${path}. Copy config.example.ini to config.ini first.`,
      {
        cause,
      },
    )
  }
  const key = parseIni(text).get('deepseek.api_key')
  if (key === undefined || key === '') {
    throw new Error(
      `deepseek.api_key is empty in ${path}. Set it locally; this file is ignored by Git.`,
    )
  }
  return key
}
