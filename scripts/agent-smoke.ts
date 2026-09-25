import { performance } from 'node:perf_hooks'

import {
  DeepSeekHarnessRuntime,
} from '@monash-study/dsh-integration'
import {
  DefaultModelPolicy,
  type CourseContext,
} from '@monash-study/study-core'
import { StudyController } from '@monash-study/study-controller'
import { loadApplicationEnvironment, loadRuntimeConfig } from '@monash-study/knowledge-service'

interface SmokeArgs {
  readonly course: CourseContext
  readonly query: string
  readonly continuity: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runtimeConfig = loadRuntimeConfig()
  loadApplicationEnvironment(runtimeConfig.applicationRoot)
  const runtime = new DeepSeekHarnessRuntime({ applicationRoot: runtimeConfig.applicationRoot })
  const controller = new StudyController(runtime, new DefaultModelPolicy())
  try {
    const started = performance.now()
    const first = await controller.runTurn({ courseContext: args.course, query: args.query })
    print('Round 1 Main Agent Smoke')
    print('')
    print('single turn: PASS')
    print(`answer: ${first.answer.trim()}`)
    print(`session id: ${first.conversation.sessionId}`)
    print(`conversation id: ${first.conversation.conversationId}`)
    print(`turn id: ${first.turnId}`)
    print(`model profile: ${first.modelProfile}`)
    print(`prompt version: ${first.promptVersion}`)
    print(`latency: ${Math.round(performance.now() - started)} ms`)

    if (args.continuity) {
      const marker = 'ORANGE-731'
      const continuityStarted = performance.now()
      const remembered = await controller.runTurn({
        courseContext: args.course,
        conversation: first.conversation,
        query: `For this conversation, remember the marker is ${marker}. Reply briefly.`,
      })
      const followup = await controller.runTurn({
        courseContext: args.course,
        conversation: remembered.conversation,
        query: 'What marker did I give you earlier in this conversation? Reply with the marker only.',
      })
      const passed = followup.answer.includes(marker)
      print('')
      print(`conversation continuity: ${passed ? 'PASS' : 'FAIL'}`)
      print(`continuity answer: ${followup.answer.trim()}`)
      print(`continuity latency: ${Math.round(performance.now() - continuityStarted)} ms`)
      if (!passed) process.exitCode = 1
    }
  } finally {
    await runtime.close()
  }
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  let courseCode: string | undefined
  let query: string | undefined
  let continuity = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--continuity') {
      continuity = true
      continue
    }
    if (arg === '--course') {
      courseCode = argv[++index]
      continue
    }
    if (arg === '--query') {
      query = argv[++index]
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (courseCode === undefined || courseCode.trim().length === 0) {
    throw new Error('Usage: pnpm agent-smoke -- --course FIT2109 --query "..." [--continuity]')
  }
  if (query === undefined || query.trim().length === 0) {
    throw new Error('Usage: pnpm agent-smoke -- --course FIT2109 --query "..." [--continuity]')
  }
  return { course: { courseCode: courseCode.trim() }, query: query.trim(), continuity }
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
