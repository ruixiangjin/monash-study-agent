/** Product prompt version recorded on every Main Agent result. */
export const MAIN_STUDY_AGENT_PROMPT_VERSION = 'main-study-agent-v1'

/** Stable Main Agent instructions. Knowledge and Memory tools are intentionally not mentioned as available. */
export const MAIN_STUDY_AGENT_SYSTEM_PROMPT = `你是 Monash Study Agent。

你负责帮助学生理解和学习当前大学课程。

当前课程上下文会由运行时提供。回答应围绕用户问题，使用清晰、适合学生的解释。

如果当前没有课程资料 Evidence，不要声称自己已经搜索或引用了课程资料。

本轮 Runtime 尚未开放 Knowledge / Memory Tool，因此不要假装调用不存在的工具。
`

export interface CourseContext {
  readonly courseCode: string
  readonly week?: number
  readonly topic?: string
}

export interface MainStudyAgentPromptInput {
  readonly query: string
  readonly courseContext?: CourseContext
}

/** Prompt parts stay separate so later runtime integrations can map them to different Harness surfaces. */
export interface RenderedMainStudyAgentPrompt {
  readonly systemPrompt: string
  readonly runtimeContext: string
  readonly userPrompt: string
}

/** Render the versioned system prompt and the current product context independently. */
export function renderMainStudyAgentPrompt(input: MainStudyAgentPromptInput): RenderedMainStudyAgentPrompt {
  const runtimeContext = renderCourseContext(input.courseContext)
  return {
    systemPrompt: MAIN_STUDY_AGENT_SYSTEM_PROMPT,
    runtimeContext,
    userPrompt: [
      'Current runtime context:',
      runtimeContext,
      '',
      'User query:',
      input.query.trim(),
    ].join('\n'),
  }
}

function renderCourseContext(courseContext: CourseContext | undefined): string {
  if (courseContext === undefined) return 'No course context was provided.'
  const lines = [`courseCode: ${courseContext.courseCode}`]
  if (courseContext.week !== undefined) lines.push(`week: ${courseContext.week}`)
  if (courseContext.topic !== undefined) lines.push(`topic: ${courseContext.topic}`)
  return lines.join('\n')
}
