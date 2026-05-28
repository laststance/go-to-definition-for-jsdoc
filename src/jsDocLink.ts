export type JsDocLinkTarget = {
  readonly rawTarget: string
  readonly targetStartCharacter: number
  readonly targetEndCharacter: number
}

type InlineLinkTargetBounds = {
  readonly startCharacter: number
  readonly endCharacter: number
  readonly linkEndCharacter: number
}

const LINK_TAG_OPENING = '{@'

const QUOTE_CHARACTERS = new Set(["'", '"', '`'])

const SUPPORTED_LINK_TAG_NAMES = ['link', 'linkplain', 'linkcode'] as const

/**
 * Finds a JSDoc inline link target under the cursor so definition lookup only triggers inside `{@link ...}`.
 * @param lineText - The single editor line that contains the cursor.
 * @param positionCharacter - The zero-based cursor character in the line.
 * @returns
 * - When the cursor is inside a link target: the raw target and character bounds
 * - When the cursor is outside a supported link target: `undefined`
 * @example
 * findJsDocLinkTargetAtPosition(" * See {@link 'useThing'}", 18)?.rawTarget // => "useThing"
 */
export const findJsDocLinkTargetAtPosition = (
  lineText: string,
  positionCharacter: number,
): JsDocLinkTarget | undefined => {
  let searchStartCharacter = 0

  while (searchStartCharacter < lineText.length) {
    const linkOpenCharacter = lineText.indexOf(LINK_TAG_OPENING, searchStartCharacter)

    if (linkOpenCharacter === -1) {
      return undefined
    }

    const linkTagName = findSupportedLinkTagName(lineText, linkOpenCharacter + LINK_TAG_OPENING.length)

    if (!linkTagName) {
      searchStartCharacter = linkOpenCharacter + LINK_TAG_OPENING.length
      continue
    }

    const targetBounds = findInlineLinkTargetBounds(lineText, linkOpenCharacter, linkTagName)

    if (!targetBounds) {
      searchStartCharacter = linkOpenCharacter + LINK_TAG_OPENING.length
      continue
    }

    // Treat the right edge as active so Go to Definition still works at the word boundary.
    if (positionCharacter >= targetBounds.startCharacter && positionCharacter <= targetBounds.endCharacter) {
      return {
        rawTarget: lineText.slice(targetBounds.startCharacter, targetBounds.endCharacter).trim(),
        targetStartCharacter: targetBounds.startCharacter,
        targetEndCharacter: targetBounds.endCharacter,
      }
    }

    searchStartCharacter = targetBounds.linkEndCharacter + 1
  }

  return undefined
}

/**
 * Detects whether a `{@...}` tag name is one of the link tags this extension owns.
 * @param lineText - The line being scanned.
 * @param tagNameStartCharacter - The first character after `{@`.
 * @returns
 * - A supported JSDoc link tag name when present
 * - `undefined` for non-link inline tags such as `{@example ...}`
 * @example
 * findSupportedLinkTagName("{@link Thing}", 2) // => "link"
 */
const findSupportedLinkTagName = (
  lineText: string,
  tagNameStartCharacter: number,
): (typeof SUPPORTED_LINK_TAG_NAMES)[number] | undefined => {
  for (const linkTagName of SUPPORTED_LINK_TAG_NAMES) {
    const tagNameEndCharacter = tagNameStartCharacter + linkTagName.length
    const characterAfterTagName = lineText.at(tagNameEndCharacter)

    // The tag must end before whitespace, the target, or the closing brace.
    if (
      lineText.slice(tagNameStartCharacter, tagNameEndCharacter) === linkTagName &&
      (!characterAfterTagName || /\s|\}/u.test(characterAfterTagName))
    ) {
      return linkTagName
    }
  }

  return undefined
}

/**
 * Locates the target slice inside a supported inline JSDoc link.
 * @param lineText - The line containing a supported inline link tag.
 * @param linkOpenCharacter - The character index where `{@` starts.
 * @param linkTagName - The already validated link tag name.
 * @returns
 * - Target bounds when a non-empty target exists
 * - `undefined` when the tag is incomplete or has no target
 * @example
 * findInlineLinkTargetBounds("See {@link 'Thing'}", 4, "link")?.startCharacter // => 16
 */
const findInlineLinkTargetBounds = (
  lineText: string,
  linkOpenCharacter: number,
  linkTagName: (typeof SUPPORTED_LINK_TAG_NAMES)[number],
): InlineLinkTargetBounds | undefined => {
  const linkEndCharacter = lineText.indexOf('}', linkOpenCharacter)

  if (linkEndCharacter === -1) {
    return undefined
  }

  const targetStartCandidateCharacter = skipWhitespace(
    lineText,
    linkOpenCharacter + LINK_TAG_OPENING.length + linkTagName.length,
    linkEndCharacter,
  )

  if (targetStartCandidateCharacter >= linkEndCharacter) {
    return undefined
  }

  const openingQuoteCharacter = lineText.at(targetStartCandidateCharacter)

  if (openingQuoteCharacter && QUOTE_CHARACTERS.has(openingQuoteCharacter)) {
    return findQuotedTargetBounds(lineText, targetStartCandidateCharacter, linkEndCharacter)
  }

  return findUnquotedTargetBounds(lineText, targetStartCandidateCharacter, linkEndCharacter)
}

/**
 * Skips whitespace between the JSDoc tag name and its target.
 * @param lineText - The scanned line.
 * @param startCharacter - The first character that may contain whitespace.
 * @param endCharacter - The exclusive search boundary.
 * @returns The first non-whitespace character or `endCharacter`.
 * @example
 * skipWhitespace("{@link   Thing}", 7, 15) // => 10
 */
const skipWhitespace = (lineText: string, startCharacter: number, endCharacter: number): number => {
  let currentCharacter = startCharacter

  while (currentCharacter < endCharacter && /\s/u.test(lineText[currentCharacter] ?? '')) {
    currentCharacter += 1
  }

  return currentCharacter
}

/**
 * Reads a quoted JSDoc link target while preserving the exact symbol text inside quotes.
 * @param lineText - The scanned line.
 * @param openingQuoteCharacter - The character index of the opening quote.
 * @param linkEndCharacter - The character index of the closing `}`.
 * @returns
 * - Target bounds inside the quotes
 * - `undefined` when the quote is unclosed or empty
 * @example
 * findQuotedTargetBounds("{@link 'Thing'}", 7, 14)?.endCharacter // => 13
 */
const findQuotedTargetBounds = (
  lineText: string,
  openingQuoteCharacter: number,
  linkEndCharacter: number,
): InlineLinkTargetBounds | undefined => {
  const quoteCharacter = lineText[openingQuoteCharacter]
  const targetStartCharacter = openingQuoteCharacter + 1
  const targetEndCharacter = lineText.indexOf(quoteCharacter ?? '', targetStartCharacter)

  if (targetEndCharacter === -1 || targetEndCharacter > linkEndCharacter || targetStartCharacter === targetEndCharacter) {
    return undefined
  }

  return {
    startCharacter: targetStartCharacter,
    endCharacter: targetEndCharacter,
    linkEndCharacter,
  }
}

/**
 * Reads an unquoted JSDoc link target up to whitespace, a pipe label separator, or the closing brace.
 * @param lineText - The scanned line.
 * @param targetStartCharacter - The first character of the unquoted target.
 * @param linkEndCharacter - The character index of the closing `}`.
 * @returns
 * - Target bounds for non-empty unquoted targets
 * - `undefined` when the target is empty
 * @example
 * findUnquotedTargetBounds("{@link Thing label}", 7, 18)?.endCharacter // => 12
 */
const findUnquotedTargetBounds = (
  lineText: string,
  targetStartCharacter: number,
  linkEndCharacter: number,
): InlineLinkTargetBounds | undefined => {
  let targetEndCharacter = targetStartCharacter

  while (targetEndCharacter < linkEndCharacter && !/[\s|]/u.test(lineText[targetEndCharacter] ?? '')) {
    targetEndCharacter += 1
  }

  if (targetStartCharacter === targetEndCharacter) {
    return undefined
  }

  return {
    startCharacter: targetStartCharacter,
    endCharacter: targetEndCharacter,
    linkEndCharacter,
  }
}
