/** Evidence returned by knowledge engines and live course tools. */
export interface Evidence {
  readonly evidenceId: string
  readonly resourceId?: string
  readonly course?: string
  readonly title: string
  readonly content: string
  readonly source: 'local' | 'lightrag' | 'ed' | 'moodle'
  readonly score?: number
  readonly metadata: Readonly<Record<string, unknown>>
}
