import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies']

const packDir = await mkdtemp(join(tmpdir(), 'uselatch-sdk-pack-'))

try {
  await execFileAsync(
    'pnpm',
    ['pack', '--config.ignore-scripts=true', '--pack-destination', packDir],
    { cwd: sdkRoot }
  )
  const [tarball] = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'))
  if (!tarball) {
    throw new Error(`pnpm pack wrote no tarball in ${packDir}`)
  }

  await execFileAsync('tar', ['-xzf', join(packDir, tarball), '-C', packDir])
  const extractDir = join(packDir, 'package')
  const packedFiles = await readdir(extractDir)
  if (!packedFiles.includes('LICENSE')) {
    throw new Error('Packed tarball is missing LICENSE')
  }
  const manifest = JSON.parse(await readFile(join(extractDir, 'package.json'), 'utf8'))

  const problems = []
  for (const field of dependencyFields) {
    const entries = manifest[field]
    if (!entries) continue
    for (const [name, version] of Object.entries(entries)) {
      if (name.startsWith('@latch/') || String(version).startsWith('workspace:')) {
        problems.push(`${field}.${name}=${version}`)
      }
    }
  }

  if (manifest.name !== '@uselatch/sdk') {
    problems.push(`name=${manifest.name}`)
  }

  if (problems.length > 0) {
    console.error('Packed manifest is not safe to publish:')
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
} finally {
  await rm(packDir, { recursive: true, force: true })
}
