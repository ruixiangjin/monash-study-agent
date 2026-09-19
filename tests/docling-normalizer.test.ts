import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { Resource } from '../packages/shared-types/src/resource.js'
import { NormalizationService } from '../services/knowledge-service/src/normalization/normalization-service.js'

test('normalizes a PDF text layer through Docling', { timeout: 300_000 }, async (context) => {
  const directory = await testDirectory(context)
  const path = join(directory, 'FIT2109 Week 05 Native.pdf')
  await writeFile(path, createTextPdf('Native PDF Text Layer 2026'))
  const resource = await pdfResource(path)
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const [document] = await service.normalize(resource)

  assert.ok(document)
  assert.equal(document.resourceId, resource.resourceId)
  assert.equal(document.sourceHash, resource.hash)
  assert.equal(document.sourcePath, path)
  assert.equal(document.contentType, 'document')
  assert.match(document.text, /Native PDF Text Layer 2026/i)
  assert.deepEqual(document.locator.pageNumbers, [1])
  assert.equal(document.locator.metadata?.doclingVersion, '2.129.0')
})

test('uses Docling OCR for a scanned text PDF', { timeout: 300_000 }, async (context) => {
  const directory = await testDirectory(context)
  const path = join(directory, 'FIT2109 Week 05 Scanned.pdf')
  createScannedPdf(path)
  const resource = await pdfResource(path)
  const service = new NormalizationService({ outputRoot: join(directory, 'normalized') })

  const [document] = await service.normalize(resource)

  assert.ok(document)
  assert.match(document.text, /SCANNED OCR SAMPLE 2026/i)
  assert.equal(document.locator.metadata?.ocrEngine, process.platform === 'darwin' ? 'ocrmac' : 'rapidocr')
  assert.equal(typeof document.locator.metadata?.usedFullPageOcr, 'boolean')
})

async function testDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'monash-docling-'))
  context.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function pdfResource(path: string): Promise<Resource> {
  const bytes = await readFile(path)
  const info = await stat(path)
  return {
    resourceId: `resource_${createHash('sha256').update(path).digest('hex').slice(0, 24)}`,
    course: 'FIT2109',
    week: 5,
    title: basename(path, extname(path)),
    source: 'local',
    resourceType: 'lesson',
    fileType: 'pdf',
    extension: 'pdf',
    path,
    relativePath: basename(path),
    rootId: 'test-root',
    modifiedAt: info.mtime.toISOString(),
    sizeBytes: info.size,
    hash: createHash('sha256').update(bytes).digest('hex'),
    textReadable: false,
  }
}

function createTextPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, '\\$&')
  const stream = `BT\n/F1 24 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

function createScannedPdf(path: string): void {
  const script = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    "image = Image.new('RGB', (2400, 700), 'white')",
    'draw = ImageDraw.Draw(image)',
    "font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'",
    'try:',
    '    font = ImageFont.truetype(font_path, 150)',
    'except OSError:',
    '    font = ImageFont.load_default(size=150)',
    "draw.text((100, 240), 'SCANNED OCR SAMPLE 2026', fill='black', font=font)",
    "image.save(sys.argv[1], 'PDF', resolution=300.0)",
  ].join('\n')
  const result = spawnSync('services/knowledge-service/.venv/bin/python', ['-c', script, path], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`Could not create scanned PDF fixture: ${result.stderr}`)
}
