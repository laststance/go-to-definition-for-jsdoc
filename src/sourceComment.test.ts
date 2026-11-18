import { describe, expect, test } from 'vitest'

import { isSourceCommentAtOffset } from './sourceComment'

describe('comment eligibility for inline link hover', () => {
  test.each([
    ['a multiline JSDoc comment', 'notes.ts', '/**\n * See {@link Thing}\n */\nconst x = 0'],
    ['a trailing line comment at end of file', 'notes.js', 'const x = 0 // {@link Thing}'],
    ['a block comment between tokens', 'notes.ts', 'const x = /* {@link Thing} */ 0'],
    ['a comment inside template interpolation', 'notes.ts', 'const x = `value: ${0 /* {@link Thing} */}`'],
    ['a JSX expression comment', 'notes.tsx', 'const x = <div>{/* {@link Thing} */}</div>'],
  ])('includes %s', (_description, fileName, sourceText) => {
    // Arrange
    const offset = sourceText.indexOf('Thing')

    // Act
    const isComment = isSourceCommentAtOffset(fileName, sourceText, offset)

    // Assert
    expect(isComment).toBe(true)
  })

  test.each([
    ['a quoted string containing comment markers', 'notes.js', 'const x = "/* {@link Thing} */"'],
    ['template text after interpolation', 'notes.ts', 'const x = `value: ${0} // {@link Thing}`'],
    ['a JSX attribute value', 'notes.jsx', 'const x = <div title="/* {@link Thing} */" />'],
  ])('excludes %s', (_description, fileName, sourceText) => {
    // Arrange
    const offset = sourceText.indexOf('Thing')

    // Act
    const isComment = isSourceCommentAtOffset(fileName, sourceText, offset)

    // Assert
    expect(isComment).toBe(false)
  })
})
