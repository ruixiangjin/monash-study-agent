import type { Evidence } from '../../../shared-types/src/evidence.js'

/** Structured request passed from StudyController to a course-domain tool. */
export interface StudyToolRequest {
  readonly query: string
  readonly course?: string
  readonly arguments: Readonly<Record<string, unknown>>
}

/** Tool capability exposed to the controller before DSH tool registration. */
export interface StudyTool {
  readonly name: string
  execute(request: StudyToolRequest): Promise<readonly Evidence[]>
}
