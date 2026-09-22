import type {
  StudentContext,
  StudentContextBuildInput,
  StudentContextBuilder,
  StudyMemoryReader,
} from './agent-runtime.js'

export interface MemoryStudentContextBuilderOptions {
  readonly limit?: number
  readonly globalLimit?: number
}

/** Builds the compact Student Context used by the Main Agent prompt. */
export class MemoryStudentContextBuilder implements StudentContextBuilder {
  readonly #reader: StudyMemoryReader
  readonly #limit: number
  readonly #globalLimit: number

  constructor(reader: StudyMemoryReader, options: MemoryStudentContextBuilderOptions = {}) {
    this.#reader = reader
    this.#limit = positiveLimit(options.limit ?? 8, 'Student Context memory limit')
    this.#globalLimit = positiveLimit(options.globalLimit ?? 10, 'Student Context global memory limit')
  }

  async build(input: StudentContextBuildInput): Promise<StudentContext> {
    const memories = await this.#reader.recall({
      query: input.query,
      ...(input.courseContext?.courseCode === undefined ? {} : { course: input.courseContext.courseCode }),
      ...(input.courseContext?.topic === undefined ? {} : { topic: input.courseContext.topic }),
      limit: this.#limit,
      globalLimit: this.#globalLimit,
    })
    return { memories }
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`)
  return value
}
