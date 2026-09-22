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
