import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

import { formatRuntimeConfiguration, loadRuntimeConfig } from '@monash-study/knowledge-service'
import {
  assertDshPackageGraph,
  defaultWebProfileDirectory,
  formatDshPackageGraph,
  inspectDshPackageGraph,
} from './dsh-package-graph.js'
import { resolveUiPaths, verifyUiPaths } from './ui-paths.js'
import { ensureDeclarativeWebProfile } from './dsh-web-profile.js'

const paths = resolveUiPaths()
await verifyUiPaths(paths)
await ensureDeclarativeWebProfile(defaultWebProfileDirectory())
const environmentPath = `${paths.productRoot}/.env`
if (existsSync(environmentPath)) loadEnvFile(environmentPath)
const runtimeConfig = loadRuntimeConfig({
  applicationRoot: paths.applicationRoot,
  configPath: paths.runtimeConfig,
  resourceManifestPath: paths.resourceManifest,
})
process.stdout.write(`${formatRuntimeConfiguration(runtimeConfig)}\n`)
const dshPackageGraph = inspectDshPackageGraph(paths, defaultWebProfileDirectory())
process.stdout.write(`${formatDshPackageGraph(dshPackageGraph)}\n`)
assertDshPackageGraph(dshPackageGraph)

const child = spawn(process.execPath, [paths.dshLauncher, 'web', '--patch', paths.runtimePatch, ...process.argv.slice(2)], {
  cwd: paths.dshRoot,
  env: {
    ...process.env,
    MONASH_STUDY_AGENT_ROOT: paths.applicationRoot,
    MONASH_STUDY_AGENT_RUNTIME_CONFIG: paths.runtimeConfig,
    MONASH_STUDY_AGENT_RESOURCE_MANIFEST: paths.resourceManifest,
    MONASH_STUDY_AGENT_PRESET_ROOT: paths.presetRoot,
  },
  stdio: 'inherit',
})

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (signal !== null) reject(new Error(`DSH Web stopped by ${signal}.`))
    else resolve(code ?? 1)
  })
})
process.exitCode = exitCode
