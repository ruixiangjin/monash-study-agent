import { readFile } from 'node:fs/promises'

import type { Resource } from '../../../../packages/shared-types/src/resource.js'
import {
  documentIdForResource,
  type NormalizedDocumentDraft,
  type ResourceNormalizer,
} from './resource-normalizer.js'

const CODE_EXTENSIONS = new Set(['awk', 'hs', 'java', 'js', 'kt', 'py', 'r', 'sh', 'ts'])

/** Preserves supported course source files without rewriting their code. */
export class CodeNormalizer implements ResourceNormalizer {
  readonly id = 'code'
  readonly version = '1'

  supports(resource: Resource): boolean {
    return resource.fileType === 'code'
      && resource.extension !== null
      && CODE_EXTENSIONS.has(resource.extension.toLowerCase())
  }

  async normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]> {
    const text = await readFile(resource.path, 'utf8')
    return [{
      documentId: documentIdForResource(resource),
      title: resource.title,
      contentType: 'code',
      text,
      locator: {
        kind: 'file',
        metadata: { language: resource.extension ?? 'unknown' },
      },
    }]
  }
}
