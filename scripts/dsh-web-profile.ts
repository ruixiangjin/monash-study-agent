import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MONASH_PLUGIN = '@monash-study/dsh-ui-plugin'
const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

interface WebProfileManifest {
  readonly name?: string
  readonly private?: boolean
  readonly dependencies?: Record<string, string>
  readonly dsh?: { profile?: { bundles?: string[] } }
}

/** Keep the Web profile declarative; the Monash host is injected by a local patch. */
export async function ensureDeclarativeWebProfile(profileDirectory: string): Promise<void> {
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WebProfileManifest
  const dependencies = { ...(manifest.dependencies ?? {}) }
  delete dependencies[MONASH_PLUGIN]
  const bundles = [...(manifest.dsh?.profile?.bundles ?? WEB_BUNDLES)]
    .filter(bundle => bundle !== MONASH_PLUGIN)
  const next = {
    ...manifest,
    dependencies,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles,
      },
    },
  }
  if (JSON.stringify(manifest) !== JSON.stringify(next)) {
    await writeFile(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`)
  }
  if (bundles.join('\0') !== WEB_BUNDLES.join('\0')) {
    throw new Error(`Web profile must contain only the vendored DSH bundles: ${WEB_BUNDLES.join(', ')}`)
  }
}

