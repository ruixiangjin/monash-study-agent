import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  formatRuntimeConfiguration,
  loadRuntimeConfig,
} from '@monash-study/knowledge-service'
import {
  initializeRuntimeDatabase,
  openRuntimeDatabase,
} from '../packages/runtime-database/src/index.js'

test('resolves relative runtime paths from the explicit application root and reports provenance', async (context) => {
  const root = await fixtureRoot(context)
  const configPath = join(root, 'config', 'runtime.json')
  const config = loadRuntimeConfig({
    applicationRoot: root,
    configPath,
    resourceManifestPath: 'resources/fixture.json',
  })

  assert.equal(config.applicationRoot, root)
  assert.equal(config.configPath, configPath)
  assert.equal(config.lightrag.sqlitePath, join(root, 'data/runtime/fixture.sqlite'))
  assert.equal(config.normalizedRoot, join(root, 'data/normalized-fixture'))
  assert.equal(config.workers.lightrag, join(root, 'workers/lightrag.py'))
  assert.equal(config.resourceManifestPath, join(root, 'resources/fixture.json'))
  assert.equal(config.provenance.applicationRoot.source, 'explicit applicationRoot')
  assert.equal(config.provenance.sqlitePath.source, 'runtime.json lightrag.sqlitePath')
  assert.match(formatRuntimeConfiguration(config), /source: explicit applicationRoot/)
  assert.doesNotMatch(formatRuntimeConfiguration(config), /DEEPSEEK|API_KEY|token/i)
})

test('does not depend on cwd or the package location when explicit root/config are supplied', async (context) => {
  const root = await fixtureRoot(context)
  const cwdA = join(root, 'cwd-a')
  const cwdB = join(root, 'cwd-b')
  await mkdir(cwdA)
  await mkdir(cwdB)
  const originalCwd = process.cwd()
  try {
    process.chdir(cwdA)
    const fromA = loadRuntimeConfig({ applicationRoot: root, configPath: 'config/runtime.json' })
    process.chdir(cwdB)
    const fromB = loadRuntimeConfig({ applicationRoot: root, configPath: 'config/runtime.json' })
    assert.deepEqual(
      {
        applicationRoot: fromA.applicationRoot,
        configPath: fromA.configPath,
        sqlitePath: fromA.lightrag.sqlitePath,
        workingRoot: fromA.lightrag.workingRoot,
        normalizedRoot: fromA.normalizedRoot,
        manifest: fromA.resourceManifestPath,
        workers: fromA.workers,
      },
      {
        applicationRoot: fromB.applicationRoot,
        configPath: fromB.configPath,
        sqlitePath: fromB.lightrag.sqlitePath,
        workingRoot: fromB.lightrag.workingRoot,
        normalizedRoot: fromB.normalizedRoot,
        manifest: fromB.resourceManifestPath,
        workers: fromB.workers,
      },
    )
  } finally {
    process.chdir(originalCwd)
  }
})

test('opening a missing runtime database fails without creating an empty database', async (context) => {
  const root = await fixtureRoot(context)
  const databasePath = join(root, 'data', 'missing.sqlite')

  assert.throws(
    () => openRuntimeDatabase(databasePath),
    /does not exist.*initialize it explicitly/,
  )
  assert.equal(existsSync(databasePath), false)

  const initialized = initializeRuntimeDatabase(databasePath)
  initialized.close()
  const reopened = openRuntimeDatabase(databasePath)
  reopened.close()
})

async function fixtureRoot(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'monash-runtime-config-'))
  context.after(async () => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    knowledgeProvider: 'lightrag',
    paths: {
      normalizedRoot: 'data/normalized-fixture',
      pythonExecutable: 'workers/python',
      workers: {
        lightrag: 'workers/lightrag.py',
        docling: 'workers/docling.py',
        memoryEmbedding: 'workers/memory.py',
      },
    },
    lightrag: {
      workingRoot: 'data/runtime/lightrag-fixture',
      sqlitePath: 'data/runtime/fixture.sqlite',
      llm: { model: 'test-model', baseUrl: 'https://example.invalid' },
      embedding: { model: 'test-embedding', dimension: 3, maxTokens: 16, batchSize: 1, maxAsync: 1 },
      query: { mode: 'mix', rerank: false, topK: 2, chunkTopK: 2 },
    },
  }, null, 2))
  return root
}
