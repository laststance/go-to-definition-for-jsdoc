import { describe, expect, test } from 'vitest'

import { createCandidateSymbolQueries } from './symbolName'

describe('createCandidateSymbolQueries', () => {
  test('keeps namespace target first then tries the final member name for workspace symbol lookup', () => {
    // Arrange
    const linkTarget = 'Namespace.useReadableDrawingItemSettingsQuery()'

    // Act
    const candidateSymbolQueries = createCandidateSymbolQueries(linkTarget)

    // Assert
    expect(candidateSymbolQueries).toEqual([
      'Namespace.useReadableDrawingItemSettingsQuery',
      'useReadableDrawingItemSettingsQuery',
    ])
  })

  test('strips import type syntax so quoted type links can jump to the referenced type name', () => {
    // Arrange
    const linkTarget = 'import("./types").ReadableDrawingItem'

    // Act
    const candidateSymbolQueries = createCandidateSymbolQueries(linkTarget)

    // Assert
    expect(candidateSymbolQueries).toEqual(['import("./types").ReadableDrawingItem', 'ReadableDrawingItem'])
  })

  test.each([
    "import(\"./it's\").Api.Widget",
    "import('./say\"hello').Api.Widget",
    'import("./escaped\\"quote").Api.Widget',
  ])('keeps quotes in the module path outside the symbol name in %s', (linkTarget) => {
    // Act
    const queries = createCandidateSymbolQueries(linkTarget)

    // Assert
    expect(queries).toEqual([linkTarget, 'Api.Widget', 'Widget'])
  })
})
