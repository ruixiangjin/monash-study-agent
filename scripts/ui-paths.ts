import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface UiPaths {
  readonly productRoot: string
  readonly dshRoot: string
  readonly dshLauncher: string
  readonly runtimeConfig: string
  readonly resourceManifest: string
  readonly runtimePatch: string
  readonly presetRoot: string
}

export function resolveUiPaths(environment: NodeJS.ProcessEnv = process.env): UiPaths {
  const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dshRoot = resolve(environment.MONASH_STUDY_AGENT_DSH_ROOT ?? join(productRoot, 'vendor/deepseek-harness'))
  return {
    productRoot,
    dshRoot,
    dshLauncher: join(dshRoot, 'apps/cli/lib/bin.js'),
    runtimeConfig: join(productRoot, 'config/runtime.json'),
    resourceManifest: join(productRoot, 'resources/resources.json'),
    runtimePatch: join(productRoot, 'config/single-runtime.cordis.patch.yml'),
    presetRoot: join(productRoot, 'config/agent-presets'),
  }
}

export async function verifyUiPaths(paths: UiPaths): Promise<void> {
  await requiredFile(paths.dshLauncher, 'DSH built launcher')
  await requiredFile(paths.runtimeConfig, 'runtime config')
  await requiredFile(paths.resourceManifest, 'resource manifest')
  await requiredFile(paths.runtimePatch, 'single-runtime DSH patch')
  await requiredFile(join(paths.presetRoot, 'monash-study-agent/agent.cordis.yml'), 'Monash Study Agent preset')
}

async function requiredFile(path: string, label: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(`Missing ${label}: ${path}`)
  }
}
