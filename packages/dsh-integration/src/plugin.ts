import { Service, type Context } from '@deepseek-ai/cordis'

import { createStudyRuntime, type StudyRuntime } from '@monash-study/study-controller'

declare module '@deepseek-ai/cordis' {
  interface Context {
    monashStudyKnowledge: MonashStudyKnowledgeService
  }
}

/** Cordis configuration supplied by a DSH profile or bundle patch. */
export interface Config {
  readonly runtimeConfigPath?: string
}

/** DSH-facing service wrapper; domain code remains independent of Cordis. */
export class MonashStudyKnowledgeService extends Service {
  readonly runtime: StudyRuntime

  constructor(ctx: Context, config: Config) {
    super(ctx, 'monashStudyKnowledge')
    this.runtime = createStudyRuntime(
      config.runtimeConfigPath === undefined ? {} : { configPath: config.runtimeConfigPath },
    )
  }
}

/** Cordis plugin name shown in DSH diagnostics. */
export const name = 'monash-study-agent-dsh-integration'

/** Register the application runtime boundary with DSH. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MonashStudyKnowledgeService, config)
}
