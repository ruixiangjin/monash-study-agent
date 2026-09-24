import { Service, type Context } from '@deepseek-ai/cordis'
import { createStudyRuntime, type StudyRuntime } from '@monash-study/study-controller'
import { MonashStudyUiService, type MonashStudyUiConfig } from './ui-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    monashStudyKnowledge: MonashStudyKnowledgeService
    monashStudyUi: MonashStudyUiService
  }
}

/** Cordis configuration supplied by a DSH profile or bundle patch. */
export type Config = MonashStudyUiConfig

/** Backward-compatible Knowledge service kept for existing DSH profiles. */
export class MonashStudyKnowledgeService extends Service {
  readonly runtime: StudyRuntime

  constructor(ctx: Context, config: Config) {
    super(ctx, 'monashStudyKnowledge')
    this.runtime = createStudyRuntime(
      config.runtimeConfigPath === undefined ? {} : { configPath: config.runtimeConfigPath },
    )
  }
}

export { MonashStudyUiService } from './ui-service.js'
export type { CourseSummary, MonashStudyAgentEvent, MonashStudyTurnRequest, MonashStudyTurnResponse } from './ui-contract.js'

/** Cordis plugin name shown in DSH diagnostics. */
export const name = 'monash-study-agent-dsh-integration'

/** Register the application runtime boundary with DSH. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MonashStudyKnowledgeService, config)
  ctx.plugin(MonashStudyUiService, config)
}
