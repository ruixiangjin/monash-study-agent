import type { CanonicalMemoryKind } from '@monash-study/shared-types'

const PREFIX_BY_KIND: Readonly<Record<CanonicalMemoryKind, string>> = {
  preference: 'preference',
  study_progress: 'progress',
  weakness: 'weakness',
  study_strategy: 'strategy',
}

const KIND_BY_PREFIX = new Map(
  Object.entries(PREFIX_BY_KIND).map(([kind, prefix]) => [prefix, kind as CanonicalMemoryKind]),
)

/** Builds the stable identity used by canonical current-state memories. */
export function createCanonicalMemoryKey(
  kind: CanonicalMemoryKind,
  ...parts: readonly string[]
): string {
  if (parts.length === 0) throw new Error('A canonical memory key needs at least one identity part')
  return [PREFIX_BY_KIND[kind], ...parts.map(normalizeKeyPart)].join(':')
}

/** Normalizes a model- or user-supplied key before uniqueness is enforced. */
export function canonicalizeMemoryKey(memoryKey: string): string {
  const [prefix = '', ...parts] = memoryKey.split(':')
  const kind = KIND_BY_PREFIX.get(prefix.trim().toLowerCase())
  if (kind === undefined || parts.length === 0) {
    throw new Error(`Invalid canonical memory key: ${memoryKey}`)
  }
  if (kind === 'preference' && isExplanationLanguageAlias(parts)) {
    return createCanonicalMemoryKey(kind, 'explanation-language')
  }
  return createCanonicalMemoryKey(kind, ...parts)
}

export function kindForMemoryKey(memoryKey: string): CanonicalMemoryKind {
  const prefix = canonicalizeMemoryKey(memoryKey).split(':', 1)[0]
  const kind = KIND_BY_PREFIX.get(prefix ?? '')
  if (kind === undefined) throw new Error(`Invalid canonical memory key: ${memoryKey}`)
  return kind
}

function normalizeKeyPart(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z]{3}\d{4}$/i.test(trimmed)) return trimmed.toUpperCase()
  const normalized = trimmed
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (normalized.length === 0) throw new Error('Canonical memory key parts cannot be empty')
  return normalized
}

function isExplanationLanguageAlias(parts: readonly string[]): boolean {
  const normalized = parts.join('-').toLowerCase()
  return normalized.includes('explanation')
    || normalized.includes('language')
    || normalized.includes('bilingual')
    || normalized.includes('chinese-only')
}
