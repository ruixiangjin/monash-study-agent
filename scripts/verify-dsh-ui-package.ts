import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT_MODULE_ID = '@monash-study/dsh-ui-plugin'
const BUILT_INS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

interface PackageManifest {
  readonly name?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly dsh?: { readonly client?: { readonly inject?: readonly string[] } }
}

export interface PackageIntegrityResult {
  readonly hostExternals: readonly string[]
  readonly clientExternals: readonly string[]
}

/** Verify the files that are actually shipped and loaded by the DSH profile. */
export async function verifyDshUiPackage(packageDirectory: string): Promise<PackageIntegrityResult> {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest
  const hostArtifactPath = join(packageDirectory, 'lib/index.js')
  const hostArtifact = await readFile(hostArtifactPath, 'utf8')
  const clientArtifact = await readFile(join(packageDirectory, 'lib/client.js'), 'utf8')
  const agentArtifact = await readFile(join(packageDirectory, 'lib/agent-plugin.js'), 'utf8')
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const hostExternals = externalPackages(hostArtifact)
  const clientExternals = externalPackages(clientArtifact)
  const agentExternals = externalPackages(agentArtifact)
  const undeclared = [...new Set([...hostExternals, ...clientExternals, ...agentExternals])]
    .filter(packageName => !declared.has(packageName))

  if (manifest.name !== CLIENT_MODULE_ID) {
    throw new Error(`Package name must be ${CLIENT_MODULE_ID}; received ${String(manifest.name)}.`)
  }
  const syntaxCheck = spawnSync(process.execPath, ['--check', hostArtifactPath], { encoding: 'utf8' })
  if (syntaxCheck.status !== 0) {
    throw new Error(`Host artifact is not valid Node syntax:\n${syntaxCheck.stderr.trim()}`)
  }
  if (!clientArtifact.includes(`id: \"${CLIENT_MODULE_ID}\"`)) {
    throw new Error(`Client ModuleLoader id must be ${CLIENT_MODULE_ID}.`)
  }
  if (undeclared.length > 0) {
    throw new Error(`Built UI artifacts contain undeclared external packages: ${undeclared.join(', ')}`)
  }
  const requiredRuntimeDependencies = [
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-sdk-client',
    '@deepseek-ai/dsh-sdk-protocol',
    '@deepseek-ai/dsh-session',
  ]
  const directRuntimeDependencies = requiredRuntimeDependencies
    .filter(packageName => packageName in (manifest.dependencies ?? {}))
  if (directRuntimeDependencies.length > 0) {
    throw new Error(`DSH runtime packages must remain profile-provided peers, not plugin dependencies: ${directRuntimeDependencies.join(', ')}`)
  }
  const missingRuntimeDependencies = requiredRuntimeDependencies
    .filter(packageName => !(packageName in (manifest.peerDependencies ?? {})))
  if (missingRuntimeDependencies.length > 0) {
    throw new Error(`SDK runtime peer closure must be declared peers: ${missingRuntimeDependencies.join(', ')}`)
  }
  const unbundledProductPackages = hostExternals.filter(name => name.startsWith('@monash-study/'))
  if (unbundledProductPackages.length > 0) {
    throw new Error(`Host artifact must bundle Monash product packages: ${unbundledProductPackages.join(', ')}`)
  }
  const missingInjectedPeers = (manifest.dsh?.client?.inject ?? [])
    .filter(packageName => !(packageName in (manifest.peerDependencies ?? {})))
  if (missingInjectedPeers.length > 0) {
    throw new Error(`DSH client injections must be peer dependencies: ${missingInjectedPeers.join(', ')}`)
  }

  return { hostExternals, clientExternals }
}

function externalPackages(source: string): string[] {
  const specifiers = new Set<string>()
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('/') || BUILT_INS.has(specifier)) continue
    specifiers.add(packageName(specifier))
  }
  return [...specifiers].sort()
}

function packageName(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0] as string
  return specifier.split('/').slice(0, 2).join('/')
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(currentFile).href) {
  const productRoot = resolve(dirname(currentFile), '..')
  const packageDirectory = join(productRoot, 'packages/dsh-ui-plugin')
  const result = await verifyDshUiPackage(packageDirectory)
  process.stdout.write(`DSH UI package integrity verified. Host externals: ${result.hostExternals.join(', ')}\n`)
}
