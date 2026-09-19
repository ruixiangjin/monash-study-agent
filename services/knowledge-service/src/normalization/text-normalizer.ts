import { readFile } from 'node:fs/promises'

import type { Resource } from '../../../../packages/shared-types/src/resource.js'
import {
  documentIdForResource,
  type NormalizedDocumentDraft,
  type ResourceNormalizer,
} from './resource-normalizer.js'

const TEXT_EXTENSIONS = new Set(['md', 'qmd', 'txt'])

/** Preserves Markdown, QMD, and plain text as one normalized document. */
export class TextNormalizer implements ResourceNormalizer {
  readonly id = 'text'
  readonly version = '1'

  supports(resource: Resource): boolean {
    return resource.extension !== null && TEXT_EXTENSIONS.has(resource.extension.toLowerCase())
  }

  async normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]> {
    const text = await readFile(resource.path, 'utf8')
    return [{
      documentId: documentIdForResource(resource),
      title: resource.title,
      contentType: resource.extension === 'txt' ? 'text' : 'markdown',
      text,
      locator: { kind: 'file' },
    }]
  }
}
