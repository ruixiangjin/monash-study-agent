import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { defaultWebProfileDirectory, inspectDshPackageGraph } from '../scripts/dsh-package-graph.js'
import { resolveUiPaths } from '../scripts/ui-paths.js'

const productRoot = fileURLToPath(new URL('..', import.meta.url))

describe('DSH Web package graph', () => {
  it('resolves product and Web profile paths from the supplied roots', () => {
    const root = join(tmpdir(), 'example-product')
    const dshRoot = join(tmpdir(), 'example-dsh')
    const dshHome = join(tmpdir(), 'example-dsh-home')
    const paths = resolveUiPaths({ MONASH_STUDY_AGENT_ROOT: root, MONASH_STUDY_AGENT_DSH_ROOT: dshRoot })
    assert.equal(paths.resourceManifest, join(root, 'data/runtime/resources.json'))
    assert.equal(paths.dshRoot, dshRoot)
    assert.equal(defaultWebProfileDirectory({ DSH_HOME: dshHome }), join(dshHome, 'profiles/web'))
  })

  it('keeps identity-sensitive DSH packages out of plugin dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(productRoot, 'packages/dsh-ui-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    for (const packageName of [
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-sdk-client',
      '@deepseek-ai/dsh-sdk-protocol',
      '@deepseek-ai/dsh-session',
    ]) {
      assert.equal(manifest.dependencies?.[packageName], undefined)
      assert.ok(manifest.peerDependencies?.[packageName] !== undefined)
    }
  })

  it('resolves the Web identity packages from one vendored DSH installation', () => {
    const graph = inspectDshPackageGraph(resolveUiPaths({ MONASH_STUDY_AGENT_ROOT: productRoot }))
    assert.equal(graph.profileMismatches.length, 0)
    assert.equal(graph.packages.every(item => item.owner === 'vendored'), true)
    assert.deepEqual(new Set(graph.packages.map(item => item.version)), new Set(['0.1.6-alpha.2', '1.0.2', '1.0.3', '4.0.2']))
  })
})
