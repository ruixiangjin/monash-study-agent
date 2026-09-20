/** Evidence returned by knowledge engines and live course tools. */
export type EvidenceSourceSystem = 'ed' | 'moodle' | 'local'

export type EvidenceRetrievalProvider = 'lightrag' | 'live-ed' | 'live-moodle' | 'local'

export interface Evidence {
  readonly evidenceId: string
  readonly resourceId?: string
  readonly course?: string
  readonly title: string
  readonly content: string
  readonly sourceSystem: EvidenceSourceSystem
  readonly retrievalProvider: EvidenceRetrievalProvider
  readonly score?: number
  readonly metadata: Readonly<Record<string, unknown>>
}
