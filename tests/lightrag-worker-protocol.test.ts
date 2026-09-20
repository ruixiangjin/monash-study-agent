import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkerRequest,
  LightRAGProtocolError,
  parseWorkerResponse,
} from '@monash-study/knowledge-service'

test('creates a versioned query-course request', () => {
  const request = createWorkerRequest('query-course', {
    runtimeConfigPath: '/tmp/runtime.json',
    workingDir: '/tmp/lightrag',
    course: 'FIT2109',
    query: 'fast-forward merge',
  }, 'request-1')

  assert.deepEqual(request, {
    protocolVersion: 1,
    requestId: 'request-1',
    command: 'query-course',
    payload: {
      runtimeConfigPath: '/tmp/runtime.json',
      workingDir: '/tmp/lightrag',
      course: 'FIT2109',
      query: 'fast-forward merge',
    },
  })
})

test('parses a valid success response', () => {
  const response = parseWorkerResponse(JSON.stringify({
    protocolVersion: 1,
    requestId: 'request-1',
    ok: true,
    result: { query: { course: 'FIT2109', chunks: [], unresolved: 0, mode: 'mix' } },
  }), 'request-1')

  assert.equal(response.ok, true)
})

test('rejects an unsupported protocol version', () => {
  assert.throws(
    () => parseWorkerResponse(JSON.stringify({
      protocolVersion: 2,
      requestId: 'request-1',
      ok: true,
      result: {},
    }), 'request-1'),
    (error: unknown) => error instanceof LightRAGProtocolError && error.code === 'PROTOCOL_VERSION_UNSUPPORTED',
  )
})

test('rejects an unknown command', () => {
  assert.throws(
    () => createWorkerRequest('unknown-command' as never, {}, 'request-1'),
    (error: unknown) => error instanceof LightRAGProtocolError && error.code === 'COMMAND_UNKNOWN',
  )
})
