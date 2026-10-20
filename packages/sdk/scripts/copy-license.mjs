import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(sdkRoot, '..', '..')
await copyFile(join(repoRoot, 'LICENSE'), join(sdkRoot, 'LICENSE'))
