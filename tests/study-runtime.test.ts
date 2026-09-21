import assert from 'node:assert/strict'
import test from 'node:test'

import { createStudyRuntime } from '@monash-study/study-controller'
import type { KnowledgeService } from '@monash-study/study-core'

test('composition root accepts a capability implementation without exposing LightRAG internals', () => {
  const knowledgeService: KnowledgeService = {
    async search() {
      return []
    },
  }

  const runtime = createStudyRuntime({ knowledgeService })

  assert.equal(runtime.knowledgeService, knowledgeService)
})
