import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

import { resolveUiPaths, verifyUiPaths } from './ui-paths.js'

const paths = resolveUiPaths()
await verifyUiPaths(paths)
const environmentPath = `${paths.productRoot}/.env`
if (existsSync(environmentPath)) loadEnvFile(environmentPath)

const child = spawn(process.execPath, [paths.dshLauncher, 'web', '--patch', paths.runtimePatch, ...process.argv.slice(2)], {
  cwd: paths.dshRoot,
  env: {
    ...process.env,
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
