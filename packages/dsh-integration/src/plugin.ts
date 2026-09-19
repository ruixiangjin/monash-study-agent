import { Service, type Context } from '@deepseek-ai/cordis'

import {
  LocalKnowledgeService,
  type LocalKnowledgeConfig,
} from '../../../services/knowledge-service/src/local/local-knowledge-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    monashStudyKnowledge: MonashStudyKnowledgeService
  }
}

/** Cordis configuration supplied by a DSH profile or bundle patch. */
export interface Config extends LocalKnowledgeConfig {}

/** DSH-facing service wrapper; domain code remains independent of Cordis. */
export class MonashStudyKnowledgeService extends Service {
  readonly local: LocalKnowledgeService

  constructor(ctx: Context, config: Config) {
    super(ctx, 'monashStudyKnowledge')
    this.local = new LocalKnowledgeService(config)
  }
}

/** Cordis plugin name shown in DSH diagnostics. */
export const name = 'monash-study-agent-dsh-integration'

/** Register the phase-one local knowledge service with DSH. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MonashStudyKnowledgeService, config)
}
