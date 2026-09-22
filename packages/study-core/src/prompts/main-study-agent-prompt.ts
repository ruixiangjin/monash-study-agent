import type { StudentContext } from '../agent-runtime.js'

/** Product prompt version recorded on every Main Agent result. */
export const MAIN_STUDY_AGENT_PROMPT_VERSION = 'main-study-agent-v2'

/** Stable Main Agent instructions for the tool-enabled Round 2 runtime. */
export const MAIN_STUDY_AGENT_SYSTEM_PROMPT = `你是 Monash Study Agent。

你负责帮助学生理解和学习当前大学课程。

当前课程上下文会由运行时提供。回答应围绕用户问题，使用清晰、适合学生的解释。

你可以使用以下只读工具：
- search_knowledge：检索当前课程资料并返回 Evidence。
- get_resource：读取指定课程资源的可读文本。
- recall_memory：读取与学生当前学习问题相关的长期 Memory。

需要课程资料时，先使用 search_knowledge；只有工具实际返回了 Evidence，才可以说答案引用了课程资料。不要编造 Evidence、资源内容或 Memory。

Student Context 中的 Memory 是已加载的学生背景信息。它可以帮助你个性化解释，但不要把 Memory 说成课程资料 Evidence。

如果工具不可用或没有返回结果，请如实说明，并基于已知内容回答。
`

/** Fallback prompt for callers that intentionally provide no Round 2 tool services. */
export const MAIN_STUDY_AGENT_NO_TOOLS_SYSTEM_PROMPT = `你是 Monash Study Agent。

你负责帮助学生理解和学习当前大学课程。

当前课程上下文会由运行时提供。回答应围绕用户问题，使用清晰、适合学生的解释。

当前运行没有开放 Knowledge / Memory Tool。如果没有课程资料 Evidence，不要声称自己已经搜索或引用了课程资料，也不要假装调用不存在的工具。
`

export interface CourseContext {
  readonly courseCode: string
  readonly week?: number
  readonly topic?: string
}

export interface MainStudyAgentPromptInput {
  readonly query: string
  readonly courseContext?: CourseContext
  readonly studentContext?: StudentContext
}

/** Prompt parts stay separate so later runtime integrations can map them to different Harness surfaces. */
export interface RenderedMainStudyAgentPrompt {
  readonly systemPrompt: string
  readonly runtimeContext: string
  readonly userPrompt: string
}

export interface MainStudyAgentPromptOptions {
  readonly toolsEnabled?: boolean
}

/** Render the versioned system prompt and the current product context independently. */
export function renderMainStudyAgentPrompt(
  input: MainStudyAgentPromptInput,
  options: MainStudyAgentPromptOptions = {},
): RenderedMainStudyAgentPrompt {
  const runtimeContext = [
    renderCourseContext(input.courseContext),
    renderStudentContext(input.studentContext),
  ].join('\n\n')
  return {
    systemPrompt: options.toolsEnabled === false
      ? MAIN_STUDY_AGENT_NO_TOOLS_SYSTEM_PROMPT
      : MAIN_STUDY_AGENT_SYSTEM_PROMPT,
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

function renderStudentContext(studentContext: MainStudyAgentPromptInput['studentContext']): string {
  if (studentContext === undefined || studentContext.memories.length === 0) {
    return 'Student context: no preloaded Memory was found.'
  }
  const memories = studentContext.memories.map(({ memory }) => (
    `- [${memory.scope}/${memory.kind}] ${memory.content}`
  ))
  return ['Student context:', ...memories].join('\n')
}

function renderCourseContext(courseContext: CourseContext | undefined): string {
  if (courseContext === undefined) return 'No course context was provided.'
  const lines = [`courseCode: ${courseContext.courseCode}`]
  if (courseContext.week !== undefined) lines.push(`week: ${courseContext.week}`)
  if (courseContext.topic !== undefined) lines.push(`topic: ${courseContext.topic}`)
  return lines.join('\n')
}
