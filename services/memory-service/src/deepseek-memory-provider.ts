import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface MemoryCompletionProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>
}

export interface DeepSeekFlashMemoryProviderOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly fetch?: typeof fetch
}

/** OpenAI-compatible DeepSeek Flash JSON completion adapter used by candidate extraction. */
export class DeepSeekFlashMemoryProvider implements MemoryCompletionProvider {
  readonly #apiKey: string | undefined
  readonly #baseUrl: string
  readonly #model: string
  readonly #fetch: typeof fetch

  constructor(options: DeepSeekFlashMemoryProviderOptions = {}) {
    loadProjectEnvironment(findRepositoryRoot(fileURLToPath(new URL('../../../', import.meta.url))))
    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')
    this.#model = options.model ?? 'deepseek-flash'
    this.#fetch = options.fetch ?? fetch
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = this.#apiKey ?? process.env.DEEPSEEK_API_KEY
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('DEEPSEEK_API_KEY is required for Memory candidate extraction')
    }
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        thinking: { type: 'disabled' },
      }),
    })
    if (!response.ok) {
      throw new Error(`DeepSeek Memory extraction failed with HTTP ${response.status}`)
    }
    const body = await response.json() as unknown
    if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
      throw new Error('DeepSeek Memory extraction returned an invalid response')
    }
    const message = body.choices[0].message
    if (!isRecord(message) || typeof message.content !== 'string' || message.content.trim().length === 0) {
      throw new Error('DeepSeek Memory extraction returned empty content')
    }
    return message.content
  }
}

function findRepositoryRoot(moduleRoot: string): string {
  let candidate = resolve(moduleRoot)
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(resolve(candidate, 'package.json'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  throw new Error(`Cannot locate repository root from ${moduleRoot}`)
}

function loadProjectEnvironment(repositoryRoot: string): void {
  const envPath = resolve(repositoryRoot, '.env')
  if (existsSync(envPath)) loadEnvFile(envPath)
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
