import {
  LightRAGKnowledgeService,
  NormalizedDocumentLoader,
} from '@monash-study/knowledge-service'

const course = 'FIT2109'
const query = 'What is a fast-forward merge in Git?'
const search = await new LightRAGKnowledgeService().searchDetailed({ query, course, limit: 5 })
const evidence = search.evidence
if (evidence.length === 0) throw new Error('LightRAG smoke returned no Evidence')

const loader = new NormalizedDocumentLoader()
for (const item of evidence) {
  if (item.resourceId === undefined) throw new Error(`Evidence has no resourceId: ${item.evidenceId}`)
  if (item.sourceSystem !== 'ed' && item.sourceSystem !== 'moodle' && item.sourceSystem !== 'local') {
    throw new Error(`Evidence has invalid sourceSystem: ${item.evidenceId}`)
  }
  if (item.retrievalProvider !== 'lightrag') {
    throw new Error(`Evidence has invalid retrievalProvider: ${item.evidenceId}`)
  }
  const documentId = item.metadata.documentId
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw new Error(`Evidence has no documentId metadata: ${item.evidenceId}`)
  }
  const document = await loader.get(documentId)
  if (document === undefined || document.resourceId !== item.resourceId) {
    throw new Error(`Evidence cannot be traced to its NormalizedDocument: ${documentId}`)
  }
}

process.stdout.write(`${JSON.stringify({
  status: 'ok',
  course,
  query,
  evidenceCount: evidence.length,
  evidence: evidence.map((item) => ({
    evidenceId: item.evidenceId,
    documentId: item.metadata.documentId,
    resourceId: item.resourceId,
    title: item.title,
    week: item.metadata.week,
    sourceSystem: item.sourceSystem,
    retrievalProvider: item.retrievalProvider,
    contentExcerpt: item.content.replace(/\s+/g, ' ').trim().slice(0, 320),
  })),
  unresolvedChunks: search.unresolvedChunks,
}, null, 2)}\n`)
