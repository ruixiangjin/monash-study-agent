import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ResourceRoot } from '@monash-study/shared-types'
import {
  NormalizationService,
  type NormalizationResult,
} from '@monash-study/knowledge-service'
import { LocalKnowledgeService } from '@monash-study/knowledge-service'

interface SourceConfigFile {
  readonly roots: readonly ResourceRoot[]
}

const rawArguments = process.argv.slice(2)
const commandArguments = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments
const [scope, selector, ...optionArguments] = commandArguments
if (scope !== 'all' && scope !== 'course' && scope !== 'resource') showUsage()
if ((scope === 'course' || scope === 'resource') && selector === undefined) showUsage()

const options = parseOptions(scope === 'all' ? [selector, ...optionArguments].filter(isString) : optionArguments)
const sourceConfigPath = resolve(options.get('--config') ?? 'config/sources.local.json')
const manifestPath = resolve(options.get('--manifest') ?? 'resources/resources.json')
const outputRoot = resolve(options.get('--output') ?? 'data/normalized')
const sourceConfig = JSON.parse(await readFile(sourceConfigPath, 'utf8')) as SourceConfigFile

const knowledge = new LocalKnowledgeService({ roots: sourceConfig.roots, manifestPath })
await knowledge.loadManifest()
const resources = scope === 'all'
  ? knowledge.listResources()
  : scope === 'course'
    ? knowledge.listResources({ course: requireSelector(selector, 'course') })
    : [requireResource(knowledge, selector)]

if (resources.length === 0) throw new Error(`No Resources matched ${scope}${selector === undefined ? '' : ` ${selector}`}`)

const normalization = new NormalizationService({ outputRoot })
const results = await normalization.normalizeMany(resources)
const summary = summarize(results)
process.stdout.write(`${JSON.stringify({ scope, selector: selector ?? null, outputRoot, ...summary }, null, 2)}\n`)
if (summary.failed > 0) process.exitCode = 1

function requireResource(knowledge: LocalKnowledgeService, resourceId: string | undefined) {
  if (resourceId === undefined) showUsage()
  const resource = knowledge.getResource(resourceId)
  if (resource === undefined) throw new Error(`Unknown Resource: ${resourceId}`)
  return resource
}

function requireSelector(value: string | undefined, scopeName: string): string {
  if (value === undefined) throw new Error(`Missing selector for ${scopeName}`)
  return value
}

function summarize(results: readonly NormalizationResult[]) {
  return {
    resources: results.length,
    normalized: results.filter((result) => result.status === 'normalized').length,
    unchanged: results.filter((result) => result.status === 'unchanged').length,
    unsupported: results.filter((result) => result.status === 'unsupported').length,
    failed: results.filter((result) => result.status === 'failed').length,
    documents: results.reduce((total, result) => total + result.documents.length, 0),
    failures: results
      .filter((result) => result.status === 'failed')
      .map((result) => ({ resourceId: result.resourceId, error: result.error })),
  }
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || !name.startsWith('--')) showUsage()
    parsed.set(name, value)
  }
  return parsed
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function showUsage(): never {
  throw new Error([
    'Usage:',
    '  pnpm normalize -- all [--config path] [--manifest path] [--output path]',
    '  pnpm normalize -- course <course> [options]',
    '  pnpm normalize -- resource <resourceId> [options]',
  ].join('\n'))
}
