import { spawn } from 'node:child_process'

import { resolveUiPaths, verifyUiPaths } from './ui-paths.js'

const paths = resolveUiPaths()
await verifyUiPaths(paths)

const child = spawn(process.execPath, [paths.dshLauncher, 'web'], {
  cwd: paths.dshRoot,
  env: {
    ...process.env,
    MONASH_STUDY_AGENT_RUNTIME_CONFIG: paths.runtimeConfig,
    MONASH_STUDY_AGENT_RESOURCE_MANIFEST: paths.resourceManifest,
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
