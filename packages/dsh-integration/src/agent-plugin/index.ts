import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  MAIN_STUDY_AGENT_SYSTEM_PROMPT,
} from '@monash-study/study-core'
import type {} from '../in-process-dsh-runtime.js'

export const name = 'monash-study-agent'
export const inject = ['tools', 'systemPrompt', 'monashStudyRuntime']

interface StudyToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: ParameterSchemaSpec
}

const definitions: readonly StudyToolDefinition[] = [
  {
    name: 'search_knowledge',
    description: 'Search the current Monash course knowledge base and return structured Evidence. Use this before making claims about course materials.',
    parameters: {
      query: { type: 'string', required: true, description: 'The course question or retrieval query.' },
      course: { type: 'string', description: 'Course code. Defaults to the current course context.' },
      week: { type: 'integer', description: 'Optional course week filter.' },
      limit: { type: 'integer', description: 'Maximum number of Evidence items.' },
    },
  },
  {
    name: 'get_resource',
    description: 'Read a known text-readable course resource by its stable resource id.',
    parameters: {
      resourceId: { type: 'string', required: true, description: 'Stable resource id returned by the resource catalogue.' },
    },
  },
  {
    name: 'recall_memory',
    description: 'Recall relevant long-term student Memory for the current study question. Memory is not course Evidence.',
    parameters: {
      query: { type: 'string', required: true, description: 'The study question used to recall relevant Memory.' },
      course: { type: 'string', description: 'Optional course scope. Defaults to the current course context.' },
      topic: { type: 'string', description: 'Optional topic scope.' },
      limit: { type: 'integer', description: 'Maximum number of scoped memories.' },
      globalLimit: { type: 'integer', description: 'Maximum number of global memories.' },
    },
  },
  {
    name: 'manage_memory',
    description: 'Deliberately form or manage long-term student Memory during the current turn. For ADD/UPDATE canonical memories (preference, study_progress, weakness, study_strategy), provide kind, scope, memoryKey, content, importance (0..1), and confidence (0..1); concise keys such as explanation_style are normalized by the product. For learning_episode, do not provide memoryKey. Do not change kind merely to bypass validation. Use for explicit remember/change/resolve/archive requests and explicit user forget requests.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['ADD', 'UPDATE', 'RESOLVE', 'ARCHIVE', 'DELETE'] },
      kind: { type: 'string', enum: ['preference', 'study_progress', 'weakness', 'learning_episode', 'study_strategy'] },
      scope: { type: 'string', enum: ['global', 'course', 'topic'] },
      course: { type: 'string' },
      topic: { type: 'string' },
      memoryKey: { type: 'string', description: 'Identity key for canonical memories. A concise key such as explanation_style is accepted for ADD/UPDATE and normalized by the product; learning_episode must omit it.' },
      targetMemoryId: { type: 'string' },
      content: { type: 'string' },
      importance: { type: 'number', description: 'Importance from 0 to 1.' },
      confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
      sourceType: { type: 'string', required: true, enum: ['user_explicit', 'system_observed', 'derived', 'agent_inferred'] },
      deleteIntent: { type: 'string', enum: ['explicit_user_forget'] },
    },
  },
]

export function apply(ctx: Context): void {
  for (const definition of definitions) {
    register(ctx, definition)
  }
  ctx.systemPrompt.section({
    name: 'monash-study-agent',
    order: 150,
    text: MAIN_STUDY_AGENT_SYSTEM_PROMPT,
  })
}

function register<const S extends ParameterSchemaSpec>(
  ctx: Context,
  definition: { readonly name: string; readonly description: string; readonly parameters: S },
): void {
  ctx.tools.register(defineTool({
    ...definition,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => ctx.root.monashStudyRuntime.executeTool(
      definition.name,
      args,
      exec.agent,
    ) as Promise<never>,
  }))
}
