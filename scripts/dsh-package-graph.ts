import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { UiPaths } from './ui-paths.js'

export interface DshPackageProvenance {
  readonly logicalName: string
  readonly version: string
  readonly packageDirectory: string
  readonly manifestPath: string
  readonly resolvedFrom: string
  readonly owner: 'vendored' | 'profile' | 'other'
}

export interface DshPackageGraph {
  readonly packages: readonly DshPackageProvenance[]
  readonly profileMismatches: readonly {
    readonly logicalName: string
    readonly expectedDirectory: string
    readonly profileDirectory: string
  }[]
}

const PACKAGE_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-api-session-controller': ['packages/bundle/web-app/lib/index.js', 'apps/cli/lib/bin.js'],
  '@deepseek-ai/dsh-agent-presets': ['packages/bundle/web-app/lib/index.js', 'apps/cli/lib/bin.js'],
  '@deepseek-ai/cordis-plugin-loader': ['packages/boot/app-boot/lib/index.js', 'apps/cli/lib/bin.js'],
  '@deepseek-ai/cordis-plugin-group': ['packages/boot/app-boot/lib/index.js', 'apps/cli/lib/bin.js'],
  '@deepseek-ai/cordis': ['packages/boot/app-boot/lib/index.js', 'apps/cli/lib/bin.js'],
}

const PACKAGE_LABELS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-api-session-controller': 'SessionController',
  '@deepseek-ai/dsh-agent-presets': 'agent-presets',
  '@deepseek-ai/cordis-plugin-loader': 'Cordis/config loader',
  '@deepseek-ai/cordis-plugin-group': 'cordis:group',
  '@deepseek-ai/cordis': 'Cordis',
}

/** Resolve identity-sensitive DSH packages from the installation that owns Web. */
export function inspectDshPackageGraph(paths: UiPaths, profileDirectory?: string): DshPackageGraph {
  const packages = Object.entries(PACKAGE_ANCHORS).map(([logicalName, relativeAnchors]) => {
    const resolved = resolveFromAnchors(paths.dshRoot, relativeAnchors, logicalName)
    const packageDirectory = findPackageDirectory(resolved)
    const manifestPath = join(packageDirectory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return {
      logicalName,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      packageDirectory,
      manifestPath,
      resolvedFrom: resolved,
      owner: packageDirectory.startsWith(resolve(paths.dshRoot) + '/') ? 'vendored' : 'other',
    } satisfies DshPackageProvenance
  })

  const profileMismatches = profileDirectory === undefined
    ? []
    : packages.flatMap(item => {
      // A stale physical directory below a profile is inert once the profile
      // manifest no longer declares it.  Only an explicit profile dependency
      // is allowed to override the vendored installation graph.
      const profileManifestPath = join(profileDirectory, 'package.json')
      if (!existsSync(profileManifestPath)) return []
      const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
        dependencies?: Record<string, unknown>
        devDependencies?: Record<string, unknown>
      }
      if (!(item.logicalName in (profileManifest.dependencies ?? {}))
        && !(item.logicalName in (profileManifest.devDependencies ?? {}))) return []
      const profilePackageDirectory = join(profileDirectory, 'node_modules', item.logicalName)
      const manifestPath = join(profilePackageDirectory, 'package.json')
      if (!existsSync(manifestPath)) return []
      const profileRealDirectory = findPackageDirectory(manifestPath)
      if (resolve(profileRealDirectory) === resolve(item.packageDirectory)) return []
      return [{
        logicalName: item.logicalName,
        expectedDirectory: item.packageDirectory,
        profileDirectory: profileRealDirectory,
      }]
    })

  return { packages, profileMismatches }
}

export function formatDshPackageGraph(graph: DshPackageGraph): string {
  const lines = ['DSH package graph']
  for (const item of graph.packages) {
    lines.push(`  ${PACKAGE_LABELS[item.logicalName] ?? item.logicalName}: version=${item.version} resolvedFrom=${item.resolvedFrom}`)
  }
  if (graph.profileMismatches.length > 0) {
    lines.push('  profile mismatches:')
    for (const mismatch of graph.profileMismatches) {
      lines.push(`    ${mismatch.logicalName}: expected=${mismatch.expectedDirectory} profile=${mismatch.profileDirectory}`)
    }
  }
  return lines.join('\n')
}

export function assertDshPackageGraph(graph: DshPackageGraph): void {
  const nonVendored = graph.packages.filter(item => item.owner !== 'vendored')
  if (nonVendored.length === 0 && graph.profileMismatches.length === 0) return
  const reasons = [
    ...nonVendored.map(item => `${item.logicalName} resolved outside the vendored DSH installation`),
    ...graph.profileMismatches.map(item => `${item.logicalName} has a different profile package instance`),
  ]
  throw new Error(`DSH package graph is not unified: ${reasons.join('; ')}`)
}

export function defaultWebProfileDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web')
}

function resolveFromAnchors(dshRoot: string, relativeAnchors: readonly string[], packageName: string): string {
  for (const relativeAnchor of relativeAnchors) {
    const anchor = join(dshRoot, relativeAnchor)
    if (!existsSync(anchor)) continue
    try {
      return createRequire(pathToFileURL(anchor)).resolve(packageName)
    } catch {
      // Try the next DSH installation anchor. The built Web bundle owns some
      // packages that are not direct dependencies of the CLI package.
    }
  }
  throw new Error(`Cannot resolve ${packageName} from the vendored DSH installation at ${dshRoot}`)
}

function findPackageDirectory(modulePath: string): string {
  let current = resolve(modulePath)
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) throw new Error(`Cannot find package.json above ${modulePath}`)
    current = parent
  }
}
