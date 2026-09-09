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
})
