/** Non-secret runtime configuration shared by TypeScript and Python boundaries. */
export interface RuntimeConfig {
  readonly schemaVersion: 1
  readonly knowledgeProvider: 'lightrag'
  readonly lightrag: {
    readonly workingRoot: string
    readonly sqlitePath: string
    readonly llm: {
      readonly model: string
      readonly baseUrl: string
    }
    readonly embedding: {
      readonly model: string
      readonly dimension: number
      readonly maxTokens: number
      readonly batchSize: number
      readonly maxAsync: number
    }
    readonly query: {
      readonly mode: 'mix'
      readonly rerank: boolean
      readonly topK: number
      readonly chunkTopK: number
    }
  }
}
