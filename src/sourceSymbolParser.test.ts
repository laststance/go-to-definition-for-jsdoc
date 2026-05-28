import { describe, expect, it } from 'vitest'

import { findSymbolDefinitionsInSourceText } from './sourceSymbolParser'

describe('findSymbolDefinitionsInSourceText', () => {
  it('finds variables and types so fallback lookup can jump when workspace symbols are missing', () => {
    // Arrange
    const sourceText = [
      'export const useReadableDrawingItemSettingsQuery = () => undefined',
      'export type ReadableDrawingItem = { id: string }',
      'interface HiddenSettings { enabled: boolean }',
    ].join('\n')

    // Act
    const definitions = findSymbolDefinitionsInSourceText({
      fileName: 'settings.ts',
      sourceText,
      candidateNames: ['useReadableDrawingItemSettingsQuery', 'ReadableDrawingItem', 'HiddenSettings'],
    })

    // Assert
    expect(definitions).toEqual([
      {
        symbolName: 'useReadableDrawingItemSettingsQuery',
        startLine: 0,
        startCharacter: 13,
        endLine: 0,
        endCharacter: 48,
      },
      {
        symbolName: 'ReadableDrawingItem',
        startLine: 1,
        startCharacter: 12,
        endLine: 1,
        endCharacter: 31,
      },
      {
        symbolName: 'HiddenSettings',
        startLine: 2,
        startCharacter: 10,
        endLine: 2,
        endCharacter: 24,
      },
    ])
  })
})
