import {
  LightRAGKnowledgeService,
  LightRAGSyncService,
  LightRAGWorkerClient,
  NormalizedDocumentLoader,
  loadApplicationEnvironment,
  loadRuntimeConfig,
} from '@monash-study/knowledge-service'

const runtimeConfig = loadRuntimeConfig()
loadApplicationEnvironment(runtimeConfig.applicationRoot)

const args = process.argv.slice(2)
const commandArguments = args[0] === '--' ? args.slice(1) : args
const command = commandArguments[0]
if (!['health', 'model-health', 'ingest-document', 'sync-document', 'index-state', 'sync-course', 'search'].includes(command ?? '')) showUsage()

try {
  const client = new LightRAGWorkerClient({ runtimeConfig })
  if (command === 'health' && commandArguments.length === 1) {
    const result = await client.health()
    process.stdout.write([
      'LightRAG runtime: OK',
      `Package: ${result.package}`,
      `Version: ${result.version}`,
      `Python: ${result.pythonVersion}`,
      `Working directory: ${result.workingDir}`,
      '',
    ].join('\n'))
  } else if (command === 'model-health' && commandArguments.length === 1) {
    const result = await client.modelHealth()
    process.stdout.write([
      'LightRAG models: OK',
      `LLM: ${result.llm.provider}/${result.llm.model}`,
      `Embedding: ${result.embedding.model}`,
      `Dimension: ${result.embedding.dimension}`,
      `Device: ${result.embedding.device}`,
      '',
    ].join('\n'))
  } else if (command === 'ingest-document' && commandArguments.length === 2) {
    const documentId = commandArguments[1]
    if (documentId === undefined) showUsage()
    const document = await new NormalizedDocumentLoader({ normalizedRoot: runtimeConfig.normalizedRoot }).get(documentId)
    if (document === undefined) throw new Error(`NormalizedDocument not found: ${documentId}`)
    const result = await client.ingestDocument(document)
    process.stdout.write([
      'LightRAG document ingestion: OK',
      `Document: ${result.documentId}`,
      `Resource: ${result.resourceId}`,
      `Course: ${result.course ?? 'UNCLASSIFIED'}`,
      `Working directory: ${result.workingDir}`,
      '',
    ].join('\n'))
  } else if (command === 'sync-document' && commandArguments.length === 2) {
    const documentId = commandArguments[1]
    if (documentId === undefined) showUsage()
    const service = new LightRAGSyncService({ runtimeConfig })
    const result = await service.syncDocument(documentId)
    process.stdout.write([
      'LightRAG document sync: OK',
      `Document: ${result.documentId}`,
      `Resource: ${result.resourceId}`,
      `Course: ${result.course ?? 'UNCLASSIFIED'}`,
      `Status: ${result.status}`,
      ...(result.indexedAt === undefined ? [] : [`Indexed at: ${result.indexedAt}`]),
      '',
    ].join('\n'))
  } else if (command === 'index-state' && commandArguments.length === 2) {
    const documentId = commandArguments[1]
    if (documentId === undefined) showUsage()
    const state = new LightRAGSyncService().getIndexState(documentId)
    if (state === undefined) {
      process.stdout.write(`No LightRAG index state:\n${documentId}\n`)
    } else {
      process.stdout.write([
        'LightRAG index state',
        '',
        `Document: ${state.documentId}`,
        `Resource: ${state.resourceId}`,
        `Course: ${state.course ?? 'UNCLASSIFIED'}`,
        `Source hash: ${state.sourceHash}`,
        `Normalized hash: ${state.normalizedHash}`,
        `Normalization version: ${state.normalizationVersion}`,
        `Source path: ${state.sourcePath}`,
        `Indexed at: ${state.indexedAt}`,
        '',
      ].join('\n'))
    }
  } else if (command === 'sync-course' && (commandArguments.length === 2 || commandArguments.length === 3)) {
    const course = commandArguments[1]
    if (course === undefined) showUsage()
    const dryRun = commandArguments[2] === '--dry-run'
    if (commandArguments.length === 3 && !dryRun) showUsage()
    const service = new LightRAGSyncService({ runtimeConfig })
    if (dryRun) {
      const plan = await service.planCourseSync(course)
      process.stdout.write([
        'LightRAG course sync plan',
        '',
        `Course: ${plan.course}`,
        `Documents: ${plan.totalDocuments}`,
        '',
        `New: ${plan.indexed.length}`,
        `Updated: ${plan.updated.length}`,
        `Unchanged: ${plan.unchanged.length}`,
        `Removed: ${plan.removed.length}`,
        '',
      ].join('\n'))
    } else {
      const result = await service.syncCourse(course)
      const lines = [
        'LightRAG course sync: OK',
        '',
        `Course: ${result.course}`,
        `Documents: ${result.totalDocuments}`,
        '',
        `Indexed: ${result.indexed}`,
        `Updated: ${result.updated}`,
        `Unchanged: ${result.unchanged}`,
        `Removed: ${result.removed}`,
        `Failed: ${result.failed}`,
      ]
      for (const failure of result.failures) {
        lines.push('', `Document: ${failure.documentId}`, `Operation: ${failure.operation}`, `Error: ${failure.message}`)
      }
      lines.push('')
      process.stdout.write(lines.join('\n'))
    }
  } else if (command === 'search') {
    const searchArguments = parseSearchArguments(commandArguments.slice(1))
    const knowledge = new LightRAGKnowledgeService({ client, runtimeConfig })
    const evidence = await knowledge.search(searchArguments)
    const lines = [
      'LightRAG search: OK',
      '',
      `Query: ${searchArguments.query}`,
      `Course: ${searchArguments.course}`,
      ...(searchArguments.week === undefined ? [] : [`Week: ${searchArguments.week}`]),
      `Evidence: ${evidence.length}`,
    ]
    for (const [index, item] of evidence.entries()) {
      const metadataDocumentId = item.metadata.documentId
      const chunkId = item.metadata.lightragChunkId
      lines.push(
        '',
        `[${index + 1}]`,
        '',
        `Evidence ID: ${item.evidenceId}`,
        `Document: ${metadataDocumentId}`,
        `Resource: ${item.resourceId ?? 'unknown'}`,
        `Title: ${item.title}`,
        `Course: ${item.course ?? 'UNCLASSIFIED'}`,
        `Week: ${item.metadata.week ?? 'unknown'}`,
        `Source system: ${item.sourceSystem}`,
        `Retrieval provider: ${item.retrievalProvider}`,
        `Chunk: ${chunkId ?? 'unknown'}`,
        `Content: ${preview(item.content)}`,
      )
    }
    lines.push('')
    process.stdout.write(lines.join('\n'))
  } else {
    showUsage()
  }
} catch (error) {
  process.stderr.write(`LightRAG ${command ?? 'command'} failed: ${errorMessage(error)}\n`)
  process.exitCode = 1
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showUsage(): never {
  throw new Error('Usage: pnpm lightrag -- health | model-health | ingest-document <documentId> | sync-document <documentId> | index-state <documentId> | sync-course <course> [--dry-run] | search --course <course> [--week <week>] [--limit <limit>] <query>')
}

function parseSearchArguments(args: readonly string[]): {
  readonly query: string
  readonly course: string
  readonly week?: number
  readonly limit?: number
} {
  let course: string | undefined
  let week: number | undefined
  let limit: number | undefined
  const queryParts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--course' || argument === '--week' || argument === '--limit') {
      const value = args[index + 1]
      if (value === undefined) showUsage()
      if (argument === '--course') course = value
      else if (argument === '--week') week = parseInteger(value, '--week')
      else limit = parseInteger(value, '--limit')
      index += 1
    } else if (argument !== undefined) {
      queryParts.push(argument)
    }
  }
  const query = queryParts.join(' ').trim()
  if (!course || !query) showUsage()
  return { query, course, ...(week === undefined ? {} : { week }), ...(limit === undefined ? {} : { limit }) }
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`)
  return Number(value)
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}
