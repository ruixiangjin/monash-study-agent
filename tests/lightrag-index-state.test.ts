import assert from 'node:assert/strict'
import test from 'node:test'

import type { NormalizedDocument } from '@monash-study/shared-types'
import { isDocumentIndexCurrent, type LightRAGIndexState } from '@monash-study/knowledge-service'

test('compares every field that identifies an indexed document version', () => {
  const document = normalizedDocument()
  const matchingState: LightRAGIndexState = {
    documentId: document.documentId,
    resourceId: document.resourceId,
    course: document.course,
    sourceHash: document.sourceHash,
    normalizedHash: document.normalizedHash,
    normalizationVersion: document.normalizationVersion,
    sourcePath: document.sourcePath,
    indexedAt: '2026-09-21T09:00:00.000Z',
  }

  assert.equal(isDocumentIndexCurrent(document, matchingState), true)
  for (const [field, value] of [
    ['normalizedHash', 'changed-normalized'],
    ['sourceHash', 'changed-source'],
    ['normalizationVersion', '2:text:1'],
    ['sourcePath', '/tmp/changed.md'],
    ['course', 'FIT2014'],
  ] as const) {
    assert.equal(
      isDocumentIndexCurrent(document, { ...matchingState, [field]: value }),
      false,
      `${field} should invalidate the index`,
    )
  }
})

function normalizedDocument(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
  return {
    documentId: 'document-a',
    resourceId: 'resource-a',
    sourceHash: 'source-a',
    title: 'Document A',
    course: 'FIT2109',
    week: null,
    source: 'moodle',
    contentType: 'markdown',
    text: '# Document A\n',
    sourcePath: '/tmp/document-a.md',
    locator: { kind: 'file' },
    normalizationVersion: '1:text:1',
    normalizedHash: 'normalized-a',
    ...overrides,
  }
}
