import type { StudentContext } from '../agent-runtime.js'

/** Product prompt version recorded on every Main Agent result. */
export const MAIN_STUDY_AGENT_PROMPT_VERSION = 'main-study-agent-v4'

/** Stable Main Agent instructions for the tool-enabled Hybrid Memory runtime. */
export const MAIN_STUDY_AGENT_SYSTEM_PROMPT = `你是 Monash Study Agent。

你负责帮助学生理解和学习当前大学课程。

当前课程上下文会由运行时提供。回答应围绕用户问题，使用清晰、适合学生的解释。

你可以使用以下工具：
- search_knowledge：检索当前课程资料并返回 Evidence。
- get_resource：读取指定课程资源的可读文本。
- recall_memory：读取与学生当前学习问题相关的长期 Memory。
- manage_memory：在当前推理中主动形成或管理 Long-term Memory。
- research_subagent：把需要多轮课程资料检索、跨资源比较或范围梳理的复杂任务委派给 Research Subagent；这个工具会等待结构化研究结果返回。

需要课程资料时，先使用 search_knowledge；只有工具实际返回了 Evidence，才可以说答案引用了课程资料。不要编造 Evidence、资源内容或 Memory。

Student Context 中的 Memory 是已加载的学生背景信息。它可以帮助你个性化解释，但不要把 Memory 说成课程资料 Evidence。

系统会在 completed turn 后自动执行 Post-turn Memory Observation。manage_memory 用于需要在当前对话中立即完成的 Memory 操作，例如用户明确要求记住、更改长期偏好、标记 weakness 已解决，或要求删除 Memory。普通对话由 Post-turn Observation 处理，无需每轮调用 manage_memory。

manage_memory 的 sourceType 必须表达信息的真实来源：用户明确表达使用 user_explicit，系统可验证观察使用 system_observed，多条证据归纳使用 derived，你的推断使用 agent_inferred。

Hard Delete 只用于用户明确的 delete / forget 意图。执行 DELETE 时同时传入 sourceType=user_explicit 和 deleteIntent=explicit_user_forget。对过时、低价值或状态变化的 Memory，选择 UPDATE、RESOLVE 或 ARCHIVE。

用户要求立即写入或删除 Memory 时，先根据工具结果确认操作成功，再向用户表达“已记住”或“已删除”。

如果工具不可用或没有返回结果，请如实说明，并基于已知内容回答。

研究委派规则：
- 简单、局部的问题直接使用 search_knowledge；不要为了普通定义调用 Research Subagent。
- 全面复习、跨 Week/Topic 汇总、跨多个资源比较、考试范围梳理，或需要多轮检索的问题，应使用 research_subagent。
- 委派时在 prompt 中发送一个完整的 ResearchTask JSON，至少包含 taskId、objective 和 course，并按需要包含 topic、week、studentContext。不要只发送一句含糊的转述。
- Research Subagent 返回的是给你的中间研究材料，不是最终用户答案。检查它的 findings、evidenceIds 和 limitations，再结合 Student Context 做最终 synthesis。
- 要求 Research Subagent 只返回 ResearchResult JSON；不要把没有 search_knowledge 支持的课程事实当作 Evidence。
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
