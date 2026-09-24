import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveUiPaths, verifyUiPaths } from './ui-paths.js'
import { verifyDshUiPackage } from './verify-dsh-ui-package.js'

const paths = resolveUiPaths()
const dshHome = join(homedir(), '.dsh')
const webProfile = join(dshHome, 'profiles/web')

await verifyUiPaths(paths)
await run('pnpm', ['run', 'build'], paths.productRoot)

const packageDirectory = join(paths.productRoot, 'packages/dsh-ui-plugin')
await verifyDshUiPackage(packageDirectory)
await allowDshRuntimeBuilds()
const packDirectory = join(dshHome, 'monash-study-agent/packages')
await mkdir(packDirectory, { recursive: true })
for (const name of await readdir(packDirectory)) {
  if (name.startsWith('monash-study-dsh-ui-plugin-') && name.endsWith('.tgz')) {
    await unlink(join(packDirectory, name))
  }
}

await run('pnpm', ['pack', '--pack-destination', packDirectory], packageDirectory)
const archiveNames = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'))
if (archiveNames.length !== 1) throw new Error(`Expected one UI plugin tarball; found ${archiveNames.length}.`)
const archivePath = join(packDirectory, archiveNames[0] as string)
await run(process.execPath, [paths.dshLauncher, 'plugin', '--profile', 'web', 'add', archivePath], paths.dshRoot)

const installedPackage = join(webProfile, 'node_modules/@monash-study/dsh-ui-plugin')
await verifyDshUiPackage(installedPackage)
await verifyProfile(webProfile, 'Web')
process.stdout.write('Monash Study UI setup ready\n')

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode}.`)
}

async function allowDshRuntimeBuilds(): Promise<void> {
  const workspacePath = join(webProfile, 'pnpm-workspace.yaml')
  const packages = [
    '@deepseek-ai/dsh-subprocess-local',
    '@google/genai',
    'koffi',
    'node-pty',
    'protobufjs',
  ] as const
  let source = await readFile(workspacePath, 'utf8')
  if (!/^allowBuilds:/mu.test(source)) source = `${source.trimEnd()}\nallowBuilds:\n`
  for (const packageName of packages) {
    const quotedKey = packageName.startsWith('@') ? `'${packageName}'` : packageName
    const entry = new RegExp(`^  ${quotedKey.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:.*$`, 'mu')
    if (entry.test(source)) source = source.replace(entry, `  ${quotedKey}: true`)
    else source = `${source.trimEnd()}\n  ${quotedKey}: true\n`
  }
  await writeFile(workspacePath, source)
}

async function verifyProfile(profileDirectory: string, label: string): Promise<void> {
  await readFile(join(profileDirectory, 'package.json'), 'utf8')
  const workspaceSettings = await readFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8')
  if (!/^nodeLinker:\s*hoisted$/mu.test(workspaceSettings) || !/^autoInstallPeers:\s*false$/mu.test(workspaceSettings)) {
    throw new Error(`${label} profile must keep nodeLinker: hoisted and autoInstallPeers: false.`)
  }
}
