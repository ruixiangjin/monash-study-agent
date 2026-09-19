import { LightRAGWorkerClient } from '../services/knowledge-service/src/lightrag/lightrag-worker-client.js'
import { NormalizedDocumentLoader } from '../services/knowledge-service/src/normalization/normalized-document-loader.js'

const args = process.argv.slice(2)
const commandArguments = args[0] === '--' ? args.slice(1) : args
const command = commandArguments[0]
if (!['health', 'model-health', 'ingest-document'].includes(command ?? '')) showUsage()

try {
  const client = new LightRAGWorkerClient()
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
    const document = await new NormalizedDocumentLoader().get(documentId)
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
  throw new Error('Usage: pnpm lightrag -- health | model-health | ingest-document <documentId>')
}
