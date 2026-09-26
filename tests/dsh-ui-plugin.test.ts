import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import type { AgentEvent, StudyTurnResult } from '@monash-study/study-core'
import { TYPERT_REMOTE } from '../packages/dsh-integration/src/remote.js'
import {
  courseCodeFromSessionEvents,
  courseCodeFromSessionId,
  createCourseSessionId,
  projectCourseConversationMessages,
  titleFromSessionEvents,
} from '../packages/dsh-integration/src/session-conversations.js'
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

test('publishes the course conversation UI Remote endpoints with native Typert transport', () => {
  assert.equal(TYPERT_REMOTE.package, '@monash-study/dsh-integration')
  assert.deepEqual(TYPERT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`), [
    'monashStudy/runTurn',
    'monashStudy/listCourses',
    'monashStudy/createConversation',
    'monashStudy/listCourseConversations',
    'monashStudy/loadConversation',
    'monashStudy/runEvents',
  ])
  assert.equal(TYPERT_REMOTE.descriptors[5]?.mode, 'stream')
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

test('registers the Study page and brand slots, then disposes them', async () => {
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
  }, 'sidebar-icon', 'main-page', 'brand-mark', 'brand-name')

  assert.equal(registrations.length, 4)
  assert.deepEqual(registrations.map(item => item.options.name), [
    'sidebar.brand.mark', 'sidebar.brand.name', 'sidebar.panellist', 'main',
  ])
  assert.equal(registrations[0]?.options.priority, -1)
  assert.equal(registrations[1]?.options.priority, -1)
  assert.equal(registrations[2]?.options.id, 'monash-study')
  assert.equal(registrations[2]?.options.label, 'Study')
  assert.equal(registrations[3]?.options.key, 'monash-study')

  dispose()
  assert.deepEqual(disposed, ['main', 'sidebar.panellist', 'sidebar.brand.name', 'sidebar.brand.mark'])
})

test('associates conversations with courses through DSH session identity and persisted prompts', () => {
  const sessionId = createCourseSessionId('FIT2109', 'turn-id')
  assert.equal(sessionId, 'monash-study-fit2109-turn-id')
  assert.equal(courseCodeFromSessionId(sessionId, ['FIT2102', 'FIT2109']), 'FIT2109')
  assert.equal(courseCodeFromSessionId('monash-study-fit2014-turn-id', ['FIT2102', 'FIT2109']), undefined)

  const events = [{
    type: 'user/message',
    data: { content: [{
      type: 'text',
      text: 'Current runtime context:\ncourseCode: FIT2109\n\nUser query:\nExplain the assessment.',
    }] },
  }]
  assert.equal(courseCodeFromSessionEvents(events, ['FIT2102', 'FIT2109']), 'FIT2109')
})

test('projects only persisted learner and assistant text into the course conversation', () => {
  const events = [
    { seq: 1, time: 10, type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context:\ncourseCode: FIT2109\n\nUser query:\nExplain the assessment.' }] } },
    { seq: 2, time: 11, type: 'tool/call', data: { name: 'research_subagent' } },
    { seq: 3, time: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here is the explanation.' }] } } },
    { seq: 4, time: 13, type: 'user/message', data: { content: [{ type: 'text', text: '   ' }] } },
  ]
  assert.deepEqual(projectCourseConversationMessages('session-1', events), [
    { id: 'session-1:1', role: 'user', content: 'Explain the assessment.', createdAt: 10 },
    { id: 'session-1:3', role: 'assistant', content: 'Here is the explanation.', createdAt: 12 },
  ])
  assert.equal(titleFromSessionEvents(events), 'Explain the assessment.')
  assert.equal(titleFromSessionEvents([
    ...events,
    { seq: 5, time: 14, type: 'session/title', data: { title: 'Assessment details' } },
  ]), 'Assessment details')
})
