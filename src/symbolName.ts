import * as ts from 'typescript'

const HASH_PREFIX_PATTERN = /^#/u

const TRAILING_CALL_PATTERN = /\([^)]*\)$/u

const TYPE_PARAMETER_SUFFIX_PATTERN = /<[^<>]*>$/u

const IMPORT_TYPE_PREFIX_TOKENS = [
  ts.SyntaxKind.ImportKeyword,
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.DotToken,
] as const

/**
 * Creates workspace symbol query candidates from a JSDoc link target.
 * @param linkTarget - The raw target text inside `{@link ...}`.
 * @returns Unique query candidates ordered from most specific to broadest.
 * @example
 * createCandidateSymbolQueries("Namespace.useThing()") // => ["Namespace.useThing", "useThing"]
 */
export const createCandidateSymbolQueries = (linkTarget: string): string[] => {
  const normalizedLinkTarget = stripDecorativeSyntax(linkTarget)
  const importTypeSymbolName = stripImportTypePrefix(normalizedLinkTarget)
  const lastMemberName = getLastMemberName(importTypeSymbolName)

  return uniqueNonEmptyStrings([normalizedLinkTarget, importTypeSymbolName, lastMemberName])
}

/**
 * Extracts the qualified symbol after an import-type prefix in a normalized target.
 * {@link createCandidateSymbolQueries} uses it for fallback queries, and the hover provider uses it for the highlight.
 * @example
 * stripImportTypePrefix('import("./types").Api.Widget') // => "Api.Widget"
 */
export const stripImportTypePrefix = (normalizedLinkTarget: string): string => {
  if (!normalizedLinkTarget.startsWith('import')) return normalizedLinkTarget

  // Let the TypeScript scanner handle quoted paths and trivia between tokens.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, normalizedLinkTarget)
  for (const token of IMPORT_TYPE_PREFIX_TOKENS) {
    if (scanner.scan() !== token) return normalizedLinkTarget
  }
  scanner.scan()
  return normalizedLinkTarget.slice(scanner.getTokenStart())
}

/**
 * Removes JSDoc syntax that is useful to readers but noisy for workspace symbol queries.
 * @param linkTarget - The raw JSDoc link target.
 * @returns The target without leading member markers, call suffixes, or type parameter suffixes.
 * @example
 * stripDecorativeSyntax("#useThing<T>()") // => "useThing"
 */
const stripDecorativeSyntax = (linkTarget: string): string => {
  return linkTarget
    .trim()
    .replace(HASH_PREFIX_PATTERN, '')
    .replace(TRAILING_CALL_PATTERN, '')
    .replace(TYPE_PARAMETER_SUFFIX_PATTERN, '')
}

/**
 * Extracts the final member name from namespace-style or class-member-style targets.
 * @param linkTarget - A normalized JSDoc link target.
 * @returns The last non-empty symbol segment.
 * @example
 * getLastMemberName("Namespace.useThing") // => "useThing"
 */
const getLastMemberName = (linkTarget: string): string => {
  const symbolSegments = linkTarget.split(/[.#]/u).filter(Boolean)

  return symbolSegments.at(-1) ?? linkTarget
}

/**
 * Deduplicates candidate names while preserving query order.
 * @param values - Candidate names that may include empty strings or duplicates.
 * @returns Unique non-empty candidate names.
 * @example
 * uniqueNonEmptyStrings(["Thing", "", "Thing"]) // => ["Thing"]
 */
const uniqueNonEmptyStrings = (values: readonly string[]): string[] => {
  const seenValues = new Set<string>()
  const uniqueValues: string[] = []

  for (const value of values) {
    const trimmedValue = value.trim()

    if (trimmedValue.length === 0 || seenValues.has(trimmedValue)) {
      continue
    }

    seenValues.add(trimmedValue)
    uniqueValues.push(trimmedValue)
  }

  return uniqueValues
}
