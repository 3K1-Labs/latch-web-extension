import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
)
const sdk = await import(entry.href)

if (typeof sdk.getLatchSDK !== 'function') {
  console.error('dist/index.js does not export getLatchSDK')
  process.exit(1)
}

if (typeof sdk.LatchModule !== 'function') {
  console.error('dist/index.js does not export LatchModule')
  process.exit(1)
}
