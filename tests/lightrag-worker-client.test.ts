import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { LightRAGWorkerClient } from '@monash-study/knowledge-service'

test('performs a real LightRAG Python runtime health check', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'monash-lightrag-worker-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))

  const result = await new LightRAGWorkerClient({ workingDir: directory }).health()

  assert.equal(result.package, 'lightrag-hku')
  assert.equal(result.version, '1.5.7')
  assert.notEqual(result.pythonVersion, '')
  assert.ok(isAbsolute(result.workingDir))
  assert.equal(result.workingDir, await realpath(directory))
})
