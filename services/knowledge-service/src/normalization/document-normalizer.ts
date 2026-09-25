import type { Resource } from '@monash-study/shared-types'
import { DoclingAdapter } from './docling-adapter.js'
import {
  documentIdForResource,
  type NormalizedDocumentDraft,
  type ResourceNormalizer,
} from './resource-normalizer.js'

const DOCLING_EXTENSIONS = new Set(['docx', 'pdf', 'pptx'])

/** Thin Resource-to-Docling adapter for PDF and modern Office documents. */
export class DocumentNormalizer implements ResourceNormalizer {
  readonly id = 'docling-document'
  readonly version = '1-docling-2.129.0'
  readonly #docling: DoclingAdapter | undefined

  constructor(docling?: DoclingAdapter) {
    this.#docling = docling
  }

  supports(resource: Resource): boolean {
    return resource.extension !== null && DOCLING_EXTENSIONS.has(resource.extension.toLowerCase())
  }

  async normalize(resource: Resource): Promise<readonly NormalizedDocumentDraft[]> {
    if (this.#docling === undefined) {
      throw new Error('DocumentNormalizer requires an explicit DoclingAdapter configuration')
    }
    const converted = await this.#docling.convert(resource.path)
    return [{
      documentId: documentIdForResource(resource),
      title: resource.title,
      contentType: 'document',
      text: converted.markdown,
      locator: {
        kind: 'document',
        pageNumbers: converted.pageNumbers,
        regions: converted.regions,
        metadata: {
          inputFormat: converted.inputFormat,
          doclingVersion: converted.doclingVersion,
          ocrEngine: converted.ocrEngine,
          usedFullPageOcr: converted.usedFullPageOcr,
          pictureCount: converted.pictureCount,
          tableCount: converted.tableCount,
        },
      },
    }]
  }
}
