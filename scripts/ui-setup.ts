import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ensureDeclarativeWebProfile } from './dsh-web-profile.js'
import { assertDshPackageGraph, defaultWebProfileDirectory, formatDshPackageGraph, inspectDshPackageGraph } from './dsh-package-graph.js'
import { resolveUiPaths, verifyUiPaths } from './ui-paths.js'
import { verifyDshUiPackage } from './verify-dsh-ui-package.js'

const paths = resolveUiPaths()
const dshHome = join(homedir(), '.dsh')
const webProfile = join(dshHome, 'profiles/web')

await verifyUiPaths(paths)
await run('pnpm', ['run', 'build'], paths.productRoot)

const packageDirectory = join(paths.productRoot, 'packages/dsh-ui-plugin')
await verifyDshUiPackage(packageDirectory)
await ensureDeclarativeWebProfile(webProfile)
await verifyProfile(webProfile, 'Web')
const dshPackageGraph = inspectDshPackageGraph(paths, webProfile)
process.stdout.write(`${formatDshPackageGraph(dshPackageGraph)}\n`)
assertDshPackageGraph(dshPackageGraph)
process.stdout.write('Monash Study UI setup ready\n')

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode}.`)
}

async function verifyProfile(profileDirectory: string, label: string): Promise<void> {
  await readFile(join(profileDirectory, 'package.json'), 'utf8')
  const workspaceSettings = await readFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8')
  if (!/^nodeLinker:\s*hoisted$/mu.test(workspaceSettings) || !/^autoInstallPeers:\s*false$/mu.test(workspaceSettings)) {
    throw new Error(`${label} profile must keep nodeLinker: hoisted and autoInstallPeers: false.`)
  }
}
