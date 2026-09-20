import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LocalKnowledgeService,
  UnsupportedResourceReadError,
} from '@monash-study/knowledge-service'

test('builds unified metadata and reads supported text', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'monash-study-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const week = join(root, 'FIT2102 Programming paradigms', 'Week 06 - Introduction to Haskell')
  await mkdir(week, { recursive: true })
  const path = join(week, 'Parser.hs')
  await writeFile(path, 'main = putStrLn "hello"\n', 'utf8')
  await mkdir(join(root, '.obsidian'))
  await writeFile(join(root, '.obsidian', 'workspace.json'), '{}', 'utf8')

  const service = new LocalKnowledgeService({ roots: [{ id: 'test', source: 'local', path: root }] })
  const manifest = await service.scan()

  assert.equal(manifest.resources.length, 1)
  const resource = manifest.resources[0]
  assert.ok(resource)
  assert.equal(resource.course, 'FIT2102')
  assert.equal(resource.week, 6)
  assert.equal(resource.fileType, 'code')
  assert.equal(resource.textReadable, true)
  assert.equal(resource.hash, createHash('sha256').update('main = putStrLn "hello"\n').digest('hex'))
  assert.equal((await service.readText(resource.resourceId)).content, 'main = putStrLn "hello"\n')
})

test('registers binary files but rejects phase-one text reads', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'monash-study-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'FIT2014 Week 05 notes.pdf')
  await writeFile(path, Buffer.from([0x25, 0x50, 0x44, 0x46]))

  const service = new LocalKnowledgeService({ roots: [{ id: 'test', source: 'moodle', path: root }] })
  const manifest = await service.scan()
  const resource = manifest.resources[0]
  assert.ok(resource)
  assert.equal(resource.fileType, 'pdf')
  assert.equal(resource.week, 5)
  assert.equal(resource.textReadable, false)
  await assert.rejects(service.readText(resource.resourceId), UnsupportedResourceReadError)
})

test('merges matching downloader metadata while hashing the current file', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'monash-study-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  const course = join(root, 'FIT2014 Theory Of Computation')
  await mkdir(join(course, 'General', 'Files'), { recursive: true })
  await writeFile(join(course, 'General', 'Files', 'notes.pdf'), 'current bytes', 'utf8')
  await writeFile(join(course, 'FIT2014 - Last Sync.json'), JSON.stringify({
    schema_version: 1,
    course: { code: 'FIT2014' },
    resources: [{
      source_id: '42',
      source_url: 'https://example.test/notes',
      source_kind: 'moodle_resource',
      local_path: 'General/Files/notes.pdf',
      mime_type: 'application/pdf',
      sha256: 'stale-downloader-hash',
      status: 'downloaded',
    }],
  }), 'utf8')

  const service = new LocalKnowledgeService({ roots: [{ id: 'moodle', source: 'moodle', path: root }] })
  const manifest = await service.scan()
  const resource = manifest.resources.find((item) => item.title === 'notes')
  assert.ok(resource)
  assert.equal(resource.hash, createHash('sha256').update('current bytes').digest('hex'))
  assert.equal(resource.downloader?.sourceId, '42')
  assert.equal(resource.downloader?.sourceKind, 'moodle_resource')
  assert.equal(resource.downloader?.mimeType, 'application/pdf')
})
