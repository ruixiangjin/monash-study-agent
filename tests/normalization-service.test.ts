import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { Resource, ResourceFileType, ResourceType } from '@monash-study/shared-types'
import { NormalizationService } from '@monash-study/knowledge-service'

test('normalizes Markdown and retains Resource traceability', async (context) => {
  const directory = await testDirectory(context)
  const path = join(directory, 'FIT2102 Week 06 Notes.md')
  await writeFile(path, '# Haskell\n\nPure functions.\n', 'utf8')
  const resource = await resourceFor(path, { fileType: 'markdown', resourceType: 'lesson' })
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const result = await service.normalizeWithStatus(resource)

  assert.equal(result.status, 'normalized')
  assert.equal(result.documents.length, 1)
  const document = result.documents[0]
  assert.ok(document)
  assert.equal(document.resourceId, resource.resourceId)
  assert.equal(document.sourceHash, resource.hash)
  assert.equal(document.sourcePath, resource.path)
  assert.equal(document.contentType, 'markdown')
  assert.equal(document.text, '# Haskell\n\nPure functions.\n')
  assert.match(document.normalizationVersion, /^1:text:/)
  assert.equal(document.normalizedHash.length, 64)

  const stored = await readFile(join(directory, 'normalized', 'FIT2102', 'local', `${document.documentId}.md`), 'utf8')
  assert.match(stored, new RegExp(`resourceId: "${resource.resourceId}"`))
  assert.match(stored, /# Haskell/)
})

test('preserves source code and converts CSV to a Markdown table', async (context) => {
  const directory = await testDirectory(context)
  const codePath = join(directory, 'FIT2102 Week 06 Parser.hs')
  const csvPath = join(directory, 'FIT2102 Week 06 results.csv')
  await writeFile(codePath, 'main = putStrLn "hello"\n', 'utf8')
  await writeFile(csvPath, 'name,score\nAlice,10\nBob,9\n', 'utf8')
  const code = await resourceFor(codePath, { fileType: 'code', resourceType: 'lesson' })
  const csv = await resourceFor(csvPath, { fileType: 'data', resourceType: 'lesson' })
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const [codeDocument] = await service.normalize(code)
  const [csvDocument] = await service.normalize(csv)

  assert.equal(codeDocument?.contentType, 'code')
  assert.equal(codeDocument?.text, 'main = putStrLn "hello"\n')
  assert.equal(csvDocument?.contentType, 'table')
  assert.match(csvDocument?.text ?? '', /\| name \| score \|/)
  assert.match(csvDocument?.text ?? '', /\| Alice \| 10 \|/)
})

test('splits real Ed downloader schema into stable thread documents', async (context) => {
  const directory = await testDirectory(context)
  const discussionDirectory = join(directory, 'FIT2109 Computer science workshop', 'Discussions')
  await mkdir(discussionDirectory, { recursive: true })
  const path = join(discussionDirectory, 'FIT2109 Computer science workshop - Discussions.json')
  await copyFile(resolve('tests/fixtures/ed-discussions.json'), path)
  const resource = await resourceFor(path, {
    source: 'ed',
    fileType: 'data',
    resourceType: 'discussion',
  })
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const documents = await service.normalize(resource)

  assert.equal(documents.length, 2)
  assert.deepEqual(documents.map((document) => document.documentId), [
    'forum-ed-fit2109-thread-101',
    'forum-ed-fit2109-thread-102',
  ])
  const first = documents[0]
  assert.ok(first)
  assert.equal(first.locator.threadId, 'thread-101')
  assert.equal(first.locator.sourceUrl, 'https://example.invalid/ed/courses/demo-fit2109/discussion/101')
  assert.match(first.text, /## Original Post/)
  assert.match(first.text, /### Accepted Answer — Lecturer One \(staff\)/)
  assert.match(first.text, /#### Reply to Answer — Student One \(student\)/)
  assert.match(first.text, /Week 5 workshop is included/)
})

test('reuses unchanged output for the same source hash and normalizer version', async (context) => {
  const directory = await testDirectory(context)
  const path = join(directory, 'FIT2014 Week 03 Notes.md')
  await writeFile(path, '# Automata\n', 'utf8')
  const resource = await resourceFor(path, { fileType: 'markdown', resourceType: 'lesson' })
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const first = await service.normalizeWithStatus(resource)
  const firstState = await service.getState(resource.resourceId)
  const second = await service.normalizeWithStatus(resource)
  const secondState = await service.getState(resource.resourceId)

  assert.equal(first.status, 'normalized')
  assert.equal(second.status, 'unchanged')
  assert.deepEqual(second.documents, first.documents)
  assert.equal(secondState?.normalizedAt, firstState?.normalizedAt)
})

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'monash-normalization-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function resourceFor(
  path: string,
  overrides: {
    readonly source?: Resource['source']
    readonly fileType: ResourceFileType
    readonly resourceType: ResourceType
  },
): Promise<Resource> {
  const bytes = await readFile(path)
  const info = await stat(path)
  const extension = extname(path).slice(1).toLowerCase()
  return {
    resourceId: `resource_${createHash('sha256').update(path).digest('hex').slice(0, 24)}`,
    course: basename(path).match(/([A-Z]{3,4}\d{4})/)?.[1] ?? path.match(/([A-Z]{3,4}\d{4})/)?.[1] ?? null,
    week: Number(path.match(/Week (\d+)/)?.[1] ?? 0) || null,
    title: basename(path, extname(path)),
    source: overrides.source ?? 'local',
    resourceType: overrides.resourceType,
    fileType: overrides.fileType,
    extension,
    path,
    relativePath: basename(path),
    rootId: 'test-root',
    modifiedAt: info.mtime.toISOString(),
    sizeBytes: info.size,
    hash: createHash('sha256').update(bytes).digest('hex'),
    textReadable: overrides.fileType !== 'pdf' && overrides.fileType !== 'office',
  }
}
