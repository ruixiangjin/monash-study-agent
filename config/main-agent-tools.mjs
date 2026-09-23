const bridgeUrl = process.env.MONASH_STUDY_AGENT_TOOL_BRIDGE_URL
const bridgeToken = process.env.MONASH_STUDY_AGENT_TOOL_BRIDGE_TOKEN

export const name = 'monash-study-agent-tools'
export const inject = ['tools']

export function apply(ctx) {
  if (!bridgeUrl || !bridgeToken) return

  register(ctx, {
    name: 'search_knowledge',
    description: 'Search the current Monash course knowledge base and return structured Evidence. Use this before making claims about course materials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The course question or retrieval query.' },
        course: { type: 'string', description: 'Course code. Defaults to the current course context.' },
        week: { type: 'integer', description: 'Optional course week filter.' },
        limit: { type: 'integer', description: 'Maximum number of Evidence items.' },
      },
      required: ['query'],
    },
  })

  register(ctx, {
    name: 'get_resource',
    description: 'Read a known text-readable course resource by its stable resource id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resourceId: { type: 'string', description: 'Stable resource id returned by the resource catalogue.' },
      },
      required: ['resourceId'],
    },
  })

  register(ctx, {
    name: 'recall_memory',
    description: 'Recall relevant long-term student Memory for the current study question. Memory is not course Evidence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The study question used to recall relevant Memory.' },
        course: { type: 'string', description: 'Optional course scope. Defaults to the current course context.' },
        topic: { type: 'string', description: 'Optional topic scope.' },
        limit: { type: 'integer', description: 'Maximum number of scoped memories.' },
        globalLimit: { type: 'integer', description: 'Maximum number of global memories.' },
      },
      required: ['query'],
    },
  })

  register(ctx, {
    name: 'manage_memory',
    description: 'Deliberately form or manage long-term student Memory during the current turn. Use for explicit remember/change/resolve/archive requests and explicit user forget requests. Normal turns are also observed after completion, so this tool is not required on every turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['ADD', 'UPDATE', 'RESOLVE', 'ARCHIVE', 'DELETE'], description: 'Requested lifecycle operation. The resolver may return NOOP.' },
        kind: { type: 'string', enum: ['preference', 'study_progress', 'weakness', 'learning_episode', 'study_strategy'], description: 'Required for ADD/UPDATE.' },
        scope: { type: 'string', enum: ['global', 'course', 'topic'], description: 'Required for ADD/UPDATE.' },
        course: { type: 'string', description: 'Course scope. Defaults to the current course context when applicable.' },
        topic: { type: 'string', description: 'Topic scope. Defaults to the current topic context when applicable.' },
        memoryKey: { type: 'string', description: 'Canonical key for preference, progress, weakness, or strategy.' },
        targetMemoryId: { type: 'string', description: 'Known Memory id for resolve, archive, or delete.' },
        content: { type: 'string', description: 'Durable Memory content. Required for ADD/UPDATE.' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'Importance score for ADD/UPDATE.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence score for ADD/UPDATE.' },
        sourceType: { type: 'string', enum: ['user_explicit', 'system_observed', 'derived', 'agent_inferred'], description: 'True information source; tool use alone does not make a candidate user_explicit.' },
        deleteIntent: { type: 'string', enum: ['explicit_user_forget'], description: 'Required only for DELETE and only when the user explicitly asked to forget or delete the Memory.' },
      },
      required: ['operation', 'sourceType'],
    },
  })
}

function register(ctx, definition) {
  ctx.tools.register({
    ...definition,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => callBridge(definition.name, args, exec.signal),
  })
}

async function callBridge(name, args, signal) {
  if (signal.aborted) throw new Error('Study Agent tool call was aborted')
  const response = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: args }),
    signal,
  })
  const body = await response.json()
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message ?? `Study Agent tool ${name} failed`)
  }
  return body.value
}
