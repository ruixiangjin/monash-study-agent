import type { Context } from '@deepseek-ai/cordis'

import { MonashStudyUiService, type MonashStudyUiConfig } from './ui-service.js'

/** Configuration supplied by the Monash Study UI bundle. */
export type Config = MonashStudyUiConfig

/** Cordis plugin name shown in DSH diagnostics. */
export const name = 'monash-study-ui'

/** Register only the UI Host boundary; the Study runtime is created on first turn. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MonashStudyUiService, config)
}

export { MonashStudyUiService } from './ui-service.js'
export type {
  CourseSummary,
  MonashStudyAgentEvent,
  MonashStudyTurnRequest,
  MonashStudyTurnResponse,
} from './ui-contract.js'
