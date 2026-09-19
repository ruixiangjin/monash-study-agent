import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ResourceRoot } from '../packages/shared-types/src/resource.js'
import { LocalKnowledgeService } from '../services/knowledge-service/src/local/local-knowledge-service.js'

interface RootConfigFile {
  readonly roots: readonly ResourceRoot[]
}

const argumentsByName = parseArguments(process.argv.slice(2))
const configPath = argumentsByName.get('--config')
const outputPath = argumentsByName.get('--output')
if (configPath === undefined || outputPath === undefined) {
  throw new Error('Usage: scan-cli --config <roots.json> --output <resources.json>')
}

const config = JSON.parse(await readFile(resolve(configPath), 'utf8')) as RootConfigFile
const service = new LocalKnowledgeService({ roots: config.roots, manifestPath: resolve(outputPath) })
const manifest = await service.scan({ writeManifest: true })
process.stdout.write(`${JSON.stringify(manifest.statistics, null, 2)}\n`)

function parseArguments(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || !name.startsWith('--')) throw new Error(`Invalid argument near ${name ?? '<end>'}`)
    parsed.set(name, value)
  }
  return parsed
}
