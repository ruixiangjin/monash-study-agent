import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalizeMemoryKey,
  createCanonicalMemoryKey,
  kindForMemoryKey,
} from '@monash-study/memory-service'

test('builds deterministic canonical memory keys', () => {
  assert.equal(
    createCanonicalMemoryKey('preference', 'Explanation Language'),
    'preference:explanation-language',
  )
  assert.equal(
    createCanonicalMemoryKey('weakness', 'fit2109', 'Git Merge'),
    'weakness:FIT2109:git-merge',
  )
  assert.equal(
    canonicalizeMemoryKey(' Progress : fit2014 : Pumping Lemma '),
    'progress:FIT2014:pumping-lemma',
  )
  assert.equal(canonicalizeMemoryKey('preference:bilingual_explanation'), 'preference:explanation-language')
  assert.equal(canonicalizeMemoryKey('preference:chinese-only-explanations'), 'preference:explanation-language')
  assert.equal(kindForMemoryKey('strategy:git:visual-first'), 'study_strategy')
  assert.throws(() => canonicalizeMemoryKey('episode:FIT2014:first'), /Invalid canonical memory key/)
})
