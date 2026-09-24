/*
 * Host-for-Client Remote contribution for the Monash Study UI plugin.
 *
 * This small artifact is intentionally kept next to the DSH integration
 * boundary. It is equivalent to the generated `typert.remote-client` artifact
 * used by DSH's own API packages, while keeping the product repository
 * independently buildable from the DSH monorepo.
 */
import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CourseSummary,
  MonashStudyAgentEvent,
  MonashStudyTurnRequest,
  MonashStudyTurnResponse,
} from './ui-contract.js'

const conversation = () => z.object({
  sessionId: z.string(),
  conversationId: z.string(),
})

const evidence = () => z.object({
  evidenceId: z.string(),
  resourceId: z.string().optional(),
  course: z.string().optional(),
  title: z.string(),
  content: z.string(),
  sourceSystem: z.union([z.literal('ed'), z.literal('moodle'), z.literal('local')]),
  retrievalProvider: z.union([z.literal('lightrag'), z.literal('live-ed'), z.literal('live-moodle'), z.literal('local')]),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()),
})

const agentEvent = () => z.object({
  runId: z.string(),
  timestamp: z.string(),
  type: z.union([
    z.literal('run_started'), z.literal('student_context_failed'), z.literal('model_started'),
    z.literal('model_completed'), z.literal('answer_completed'), z.literal('memory_observation_started'),
    z.literal('memory_observation_completed'), z.literal('memory_observation_failed'),
    z.literal('subagent_started'), z.literal('subagent_completed'), z.literal('subagent_failed'),
    z.literal('run_completed'), z.literal('run_failed'),
  ]),
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
  turnId: z.string().optional(),
  modelProfile: z.union([z.literal('fast'), z.literal('strong')]).optional(),
  resultCount: z.number().optional(),
  evidenceCount: z.number().optional(),
  subagentName: z.string().optional(),
  taskId: z.string().optional(),
  errorCode: z.union([
    z.literal('INVALID_INPUT'), z.literal('SESSION_ERROR'), z.literal('MODEL_ERROR'),
    z.literal('HARNESS_ERROR'), z.literal('ABORTED'), z.literal('CONCURRENT_RUN'),
    z.literal('UNKNOWN'), z.literal('STUDENT_CONTEXT_FAILED'),
    z.literal('MEMORY_OBSERVATION_FAILED'), z.literal('SUBAGENT_FAILED'),
  ]).optional(),
})

const courseSummary = () => z.object({
  courseCode: z.string(),
  resourceCount: z.number(),
})

const turnRequest = () => z.object({
  runId: z.string(),
  query: z.string(),
  courseCode: z.string(),
  conversation: conversation().optional(),
})

const turnResult = () => z.object({
  runId: z.string(),
  answer: z.string(),
  conversation: conversation(),
  turnId: z.string(),
  modelProfile: z.union([z.literal('fast'), z.literal('strong')]),
  promptVersion: z.string(),
  evidence: z.array(evidence()),
  toolsUsed: z.array(z.string()),
  subagentsUsed: z.array(z.string()),
  researchActions: z.number(),
})

const turnResponse = () => z.union([
  z.object({ status: z.literal('completed'), result: turnResult() }),
  z.object({
    status: z.literal('failed'),
    errorCode: z.union([
      z.literal('INVALID_INPUT'), z.literal('SESSION_ERROR'), z.literal('MODEL_ERROR'),
      z.literal('HARNESS_ERROR'), z.literal('ABORTED'), z.literal('CONCURRENT_RUN'), z.literal('UNKNOWN'),
    ]),
    message: z.string(),
  }),
])

const stringCodec = (typeSymbol: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create: () => z.string(),
})

const runTurnCodec = () => ({
  mode: 'strict' as const,
  typeSymbol: '@monash-study/dsh-integration/ui-contract#MonashStudyTurnRequest',
  create: turnRequest,
})

const listCoursesResultCodec = () => ({
  mode: 'strict' as const,
  typeSymbol: '@monash-study/dsh-integration/ui-contract#CourseSummary[]',
  create: () => z.array(courseSummary()),
})

const runTurnResultCodec = () => ({
  mode: 'strict' as const,
  typeSymbol: '@monash-study/dsh-integration/ui-contract#MonashStudyTurnResponse',
  create: turnResponse,
})

const agentEventCodec = () => ({
  mode: 'strict' as const,
  typeSymbol: '@monash-study/dsh-integration/ui-contract#MonashStudyAgentEvent',
  create: agentEvent,
})

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@monash-study/dsh-integration',
  descriptors: [
    {
      id: '@monash-study/dsh-integration#monashStudy/runTurn',
      service: 'monashStudyUi',
      namespace: 'monashStudy',
      method: 'runTurn',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: runTurnCodec() }],
      cancellation: { parameter: 'signal' },
      result: runTurnResultCodec(),
      sourceLocation: { file: 'packages/dsh-integration/src/ui-service.ts', line: 68, column: 3 },
    },
    {
      id: '@monash-study/dsh-integration#monashStudy/listCourses',
      service: 'monashStudyUi',
      namespace: 'monashStudy',
      method: 'listCourses',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: listCoursesResultCodec(),
      sourceLocation: { file: 'packages/dsh-integration/src/ui-service.ts', line: 99, column: 3 },
    },
    {
      id: '@monash-study/dsh-integration#monashStudy/runEvents',
      service: 'monashStudyUi',
      namespace: 'monashStudy',
      method: 'runEvents',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'runId', wire: 'runId', source: 'json', codec: stringCodec('string') }],
      cancellation: { parameter: 'signal' },
      result: agentEventCodec(),
      sourceLocation: { file: 'packages/dsh-integration/src/ui-service.ts', line: 111, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d6f6e6173685374756479 {
    runTurn: (request: MonashStudyTurnRequest, signal?: AbortSignal) => Promise<RemoteResult<MonashStudyTurnResponse>>
    listCourses: (signal?: AbortSignal) => Promise<RemoteResult<readonly CourseSummary[]>>
    runEvents: (runId: string, signal?: AbortSignal) => AsyncIterable<MonashStudyAgentEvent>
  }

  interface TypertRemoteMap {
    'monashStudy/runTurn': (request: MonashStudyTurnRequest, signal?: AbortSignal) => Promise<RemoteResult<MonashStudyTurnResponse>>
    'monashStudy/listCourses': (signal?: AbortSignal) => Promise<RemoteResult<readonly CourseSummary[]>>
    'monashStudy/runEvents': (runId: string, signal?: AbortSignal) => AsyncIterable<MonashStudyAgentEvent>
  }

  interface TypertRemoteNamespaceMap {
    monashStudy: TypertRemoteNamespace$6d6f6e6173685374756479
  }
}
