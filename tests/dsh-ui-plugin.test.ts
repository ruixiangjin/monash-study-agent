import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import type { AgentEvent, StudyTurnResult } from '@monash-study/study-core'
import { TYPERT_REMOTE } from '../packages/dsh-integration/src/remote.js'
import { LazyStudyApplication } from '../packages/dsh-integration/src/ui-service.js'
import { inject, registerMonashStudySlots } from '../packages/dsh-ui-plugin/src/client/registration.js'
import {
  ACTIVITY_LABELS,
  activityState,
  errorLabel,
  toActivityItem,
  toEvidenceCards,
} from '../packages/dsh-ui-plugin/src/client/presenters.js'

function event(type: AgentEvent['type']): AgentEvent {
  return { runId: 'run-1', timestamp: `2026-09-22T00:00:00.000Z:${type}`, type }
}

test('maps every product AgentEvent to the required UI activity copy and state', () => {
  const types = Object.keys(ACTIVITY_LABELS) as AgentEvent['type'][]
  assert.deepEqual(types.map(type => toActivityItem(event(type)).label), [
    'Starting',
    'Continuing without saved student context',
    'Thinking',
    'Reasoning completed',
    'Answer ready',
    'Updating learning memory',
    'Learning memory updated',
    'Memory update unavailable',
    'Researching course materials',
    'Research completed',
    'Research step unavailable',
    'Completed',
    'Run failed',
  ])
  assert.equal(activityState(event('run_started')), 'active')
  assert.equal(activityState(event('answer_completed')), 'completed')
  assert.equal(activityState(event('subagent_failed')), 'failed')
})

test('preserves evidence provenance and locator metadata for expandable cards', () => {
  const result = {
    runId: 'run-1',
    answer: 'Answer',
    conversation: { sessionId: 'session-1', conversationId: 'conversation-1' },
    turnId: 'turn-1',
    modelProfile: 'fast',
    promptVersion: 'test',
    toolsUsed: [],
    subagentsUsed: ['research'],
    researchActions: 2,
    evidence: [{
      evidenceId: 'evidence-1',
      resourceId: 'resource-1',
      course: 'FIT2102',
      title: 'Week 5 notes',
      content: 'Reactive streams',
      sourceSystem: 'moodle',
      retrievalProvider: 'lightrag',
      score: 0.91,
      metadata: { locator: { kind: 'document', pageNumbers: [5] } },
    }],
  } satisfies StudyTurnResult

  assert.deepEqual(toEvidenceCards(result), [{
    id: 'evidence-1',
    resourceId: 'resource-1',
    course: 'FIT2102',
    title: 'Week 5 notes',
    source: 'moodle',
    provider: 'lightrag',
    content: 'Reactive streams',
    score: 0.91,
    metadata: { locator: { kind: 'document', pageNumbers: [5] } },
  }])
})

test('keeps the stable runtime error labels at the UI boundary', () => {
  assert.equal(errorLabel('INVALID_INPUT'), 'Invalid question')
  assert.equal(errorLabel('SESSION_ERROR'), 'Conversation could not be continued')
  assert.equal(errorLabel('MODEL_ERROR'), 'Model returned no answer')
  assert.equal(errorLabel('HARNESS_ERROR'), 'Agent runtime failed')
  assert.equal(errorLabel('ABORTED'), 'Request cancelled')
  assert.equal(errorLabel('CONCURRENT_RUN'), 'Another study request is running')
  assert.equal(errorLabel('UNKNOWN'), 'Something went wrong')
})

test('publishes the three UI Remote endpoints with native Typert transport', () => {
  assert.equal(TYPERT_REMOTE.package, '@monash-study/dsh-integration')
  assert.deepEqual(TYPERT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`), [
    'monashStudy/runTurn',
    'monashStudy/listCourses',
    'monashStudy/runEvents',
  ])
  assert.equal(TYPERT_REMOTE.descriptors[2]?.mode, 'stream')
  assert.ok(inject.includes('remote'))
  assert.ok(inject.includes('slots'))
})

test('creates one shared StudyApplication lazily and closes it idempotently', async () => {
  let createCount = 0
  let closeCount = 0
  const application = {
    runTurn: async () => { throw new Error('not used') },
    close: async () => { closeCount += 1 },
  }
  const lazy = new LazyStudyApplication(async () => {
    createCount += 1
    return application
  })

  assert.equal(createCount, 0)
  assert.equal(await lazy.get(), application)
  assert.equal(await lazy.get(), application)
  assert.equal(createCount, 1)
  await Promise.all([lazy.close(), lazy.close()])
  assert.equal(closeCount, 1)
  await assert.rejects(lazy.get(), /closed/)
})

test('disposing before the first turn does not create StudyApplication', async () => {
  let createCount = 0
  const lazy = new LazyStudyApplication(async () => {
    createCount += 1
    throw new Error('must not run')
  })
  await lazy.close()
  assert.equal(createCount, 0)
})

test('registers the Monash page in the sidebar and keyed main slot, then disposes both', async () => {
  const registrations: Array<{ readonly options: Record<string, unknown>; readonly component: unknown }> = []
  const disposed: string[] = []
  const dispose = registerMonashStudySlots({
    slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => { disposed.push(String(options.name)) }
      },
    },
  }, 'sidebar-icon', 'main-page')

  assert.equal(registrations.length, 2)
  assert.deepEqual(registrations.map(item => item.options.name), ['sidebar.panellist', 'main'])
  assert.equal(registrations[0]?.options.id, 'monash-study')
  assert.equal(registrations[1]?.options.key, 'monash-study')

  dispose()
  assert.deepEqual(disposed, ['main', 'sidebar.panellist'])
})
