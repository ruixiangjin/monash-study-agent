import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { NormalizedDocument } from '@monash-study/shared-types'
import { NormalizedDocumentLoader } from '@monash-study/knowledge-service'

test('loads documents, ignores state, filters exactly, and sorts stably', async (context) => {
  const root = await testDirectory(context)
  await writeDocument(root, document('FIT2109', 'moodle', 'document-z', 'resource-z'))
  await writeDocument(root, document('FIT2109', 'ed', 'document-b', 'resource-b'))
  await writeDocument(root, document('FIT2102', 'ed', 'document-a', 'resource-a'))
  await mkdir(join(root, '.state'), { recursive: true })
  await writeFile(join(root, '.state', 'ignored.json'), '{not a document}', 'utf8')

  const loader = new NormalizedDocumentLoader({ normalizedRoot: root })
  const documents = await loader.list()

  assert.deepEqual(documents.map((item) => item.documentId), [
    'document-a',
    'document-b',
    'document-z',
  ])
  assert.equal((await loader.list({ course: 'FIT2109' })).length, 2)
  assert.deepEqual((await loader.list({ source: 'moodle' })).map((item) => item.documentId), ['document-z'])
  assert.deepEqual((await loader.list({ resourceId: 'resource-b' })).map((item) => item.documentId), ['document-b'])
  assert.equal((await loader.get('document-b'))?.resourceId, 'resource-b')
  assert.equal(await loader.get('missing'), undefined)
})

test('reports the JSON file path for malformed documents', async (context) => {
  const root = await testDirectory(context)
  const path = join(root, 'FIT2109', 'ed', 'broken.json')
  await mkdir(join(root, 'FIT2109', 'ed'), { recursive: true })
  await writeFile(path, '{not valid json}', 'utf8')

  const loader = new NormalizedDocumentLoader({ normalizedRoot: root })

  await assert.rejects(loader.list(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Malformed NormalizedDocument JSON/)
    assert.match(error.message, /broken\.json/)
    return true
  })
})

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'monash-normalized-loader-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeDocument(root: string, document: NormalizedDocument): Promise<void> {
  const directory = join(root, document.course ?? 'UNCLASSIFIED', document.source)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${document.documentId}.json`), `${JSON.stringify(document)}\n`, 'utf8')
}

function document(course: string, source: NormalizedDocument['source'], documentId: string, resourceId: string): NormalizedDocument {
  return {
    documentId,
    resourceId,
    sourceHash: `${resourceId}-source-hash`,
    title: documentId,
    course,
    week: null,
    source,
    contentType: 'markdown',
    text: `# ${documentId}\n`,
    sourcePath: `/tmp/${documentId}.md`,
    locator: { kind: 'file' },
    normalizationVersion: '1:text:1',
    normalizedHash: `${resourceId}-normalized-hash`,
  }
}
