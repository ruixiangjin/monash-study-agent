import { cp, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { resolveUiPaths } from './ui-paths.js'

const paths = resolveUiPaths()
const sourceDirectory = join(paths.productRoot, 'packages/dsh-ui-plugin/lib')
const targetDirectory = paths.dshUiPluginRuntime
const sourceManifest = join(paths.productRoot, 'packages/dsh-ui-plugin/package.json')

await mkdir(targetDirectory, { recursive: true })
await cp(sourceDirectory, join(targetDirectory, 'lib'), { recursive: true })
const manifest = JSON.parse(await readFile(sourceManifest, 'utf8')) as Record<string, unknown>
await writeFile(join(targetDirectory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

const dshPackages = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-sdk-client': 'packages/sdk/client',
  '@deepseek-ai/dsh-typert-protocol': 'packages/typert/protocol',
} as const
for (const [packageName, relativeDirectory] of Object.entries(dshPackages)) {
  const link = join(targetDirectory, 'node_modules', packageName)
  await mkdir(join(link, '..'), { recursive: true })
  const target = resolve(paths.dshRoot, relativeDirectory)
  try {
    const current = await lstat(link)
    if (!current.isSymbolicLink()) throw new Error(`not a symlink: ${link}`)
    if (await readlink(link) !== target) await unlink(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await lstat(link)
  } catch {
    await symlink(target, link, 'junction')
  }
}

process.stdout.write(`Staged local DSH UI runtime: ${targetDirectory}\n`)
