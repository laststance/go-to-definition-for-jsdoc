import { describe, expect, it } from 'vitest'

import { findJsDocLinkTargetAtPosition } from './jsDocLink'

describe('findJsDocLinkTargetAtPosition', () => {
  it('captures quoted JSDoc link targets so Go to Definition can resolve unimported symbols', () => {
    // Arrange
    const lineText = " * See {@link 'useReadableDrawingItemSettingsQuery'} for cache behavior."

    // Act
    const linkTarget = findJsDocLinkTargetAtPosition(lineText, 20)

    // Assert
    expect(linkTarget).toEqual({
      rawTarget: 'useReadableDrawingItemSettingsQuery',
      targetStartCharacter: 15,
      targetEndCharacter: 50,
    })
  })

  it('ignores cursor positions outside the link target so normal editor navigation still owns them', () => {
    // Arrange
    const lineText = " * See {@link 'useReadableDrawingItemSettingsQuery'} for cache behavior."

    // Act
    const linkTarget = findJsDocLinkTargetAtPosition(lineText, 5)

    // Assert
    expect(linkTarget).toBeUndefined()
  })

  it('captures unquoted link targets to preserve existing JSDoc link behavior', () => {
    // Arrange
    const lineText = ' * See {@link ReadableDrawingItem label text}.'

    // Act
    const linkTarget = findJsDocLinkTargetAtPosition(lineText, 18)

    // Assert
    expect(linkTarget).toEqual({
      rawTarget: 'ReadableDrawingItem',
      targetStartCharacter: 14,
      targetEndCharacter: 33,
    })
  })
})
