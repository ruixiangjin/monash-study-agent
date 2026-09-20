import { readFile } from 'node:fs/promises'

import { parse } from 'csv-parse/sync'

import type { Resource } from '@monash-study/shared-types'
import {
  documentIdForResource,
  type NormalizedDocumentDraft,
  type ResourceNormalizer,
} from './resource-normalizer.js'

/** Converts CSV and TSV rows into a Markdown table suitable for retrieval. */
export class CsvNormalizer implements ResourceNormalizer {
  readonly id = 'csv'
  readonly version = '1'

  supports(resource: Resource): boolean {
    return resource.extension === 'csv' || resource.extension === 'tsv'
  }

  async normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]> {
    const raw = await readFile(resource.path, 'utf8')
    const delimiter = resource.extension === 'tsv' ? '\t' : ','
    const rows = parse(raw, {
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][]
    const text = renderMarkdownTable(rows)
    return [{
      documentId: documentIdForResource(resource),
      title: resource.title,
      contentType: 'table',
      text,
      locator: {
        kind: 'file',
        metadata: { format: resource.extension, rowCount: rows.length },
      },
    }]
  }
}

function renderMarkdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_Empty table._\n'
  const columnCount = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => Array.from(
    { length: columnCount },
    (_, index) => escapeCell(row[index] ?? ''),
  ))
  const header = normalized[0] ?? []
  const body = normalized.slice(1)
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
    '',
  ].join('\n')
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
}
