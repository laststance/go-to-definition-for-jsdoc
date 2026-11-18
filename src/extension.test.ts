import type * as vscode from 'vscode'
import { beforeEach, expect, test, vi } from 'vitest'

import { activate } from './extension'
import { resolveDefinitionLocations } from './workspaceSymbolResolver'

const { registerHoverProvider } = vi.hoisted(() => ({
  registerHoverProvider: vi.fn<typeof vscode.languages.registerHoverProvider>(),
}))

vi.mock('vscode', () => ({
  languages: { registerDefinitionProvider: vi.fn(), registerHoverProvider },
  Range: class {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  },
  Hover: class {
    constructor(readonly contents: string, readonly range: vscode.Range) {}
  },
}))

vi.mock('./workspaceSymbolResolver', () => ({ resolveDefinitionLocations: vi.fn() }))

const linkLine = " * {@link '  Api.Widget  ' | help}"
const source = ['/**', ' * Widget documentation.', ' *', linkLine, ' */'].join('\n')
const linkDocument: Pick<vscode.TextDocument, 'fileName' | 'lineAt' | 'getText' | 'offsetAt'> = {
  fileName: 'usage.ts',
  lineAt: () => ({ text: linkLine }) as vscode.TextLine,
  getText: () => source,
  offsetAt: (at) => source.indexOf(linkLine) + at.character,
}
const document = linkDocument as vscode.TextDocument
const position = { line: 3, character: 15 } as vscode.Position
let provider: vscode.HoverProvider
const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  const context: Pick<vscode.ExtensionContext, 'subscriptions'> = { subscriptions: [] }
  activate(context as vscode.ExtensionContext)
  provider = registerHoverProvider.mock.calls[0][1]
  token.isCancellationRequested = false
})

test('highlights the full qualified name inside the quotes when its definition exists', async () => {
  // Arrange
  vi.mocked(resolveDefinitionLocations).mockResolvedValueOnce([{} as vscode.Location])

  // Act
  const hover = await provider.provideHover(document, position, token)

  // Assert
  expect(hover).toEqual({
    contents: 'Go to Definition',
    range: { startLine: 3, startCharacter: 13, endLine: 3, endCharacter: 23 },
  })
})

test('leaves a JSDoc target unhighlighted when its definition cannot be found', async () => {
  // Arrange
  vi.mocked(resolveDefinitionLocations).mockResolvedValueOnce([])

  // Act
  const hover = await provider.provideHover(document, position, token)

  // Assert
  expect(hover).toBeUndefined()
})

test.each([
  ['the leading space', 11],
  ['the trailing space', 23],
  ['the closing quote', 25],
  ['the link label', 29],
])('leaves %s unhighlighted without starting a definition search', async (_, character) => {
  // Arrange
  const outside = { line: 3, character } as vscode.Position

  // Act
  const hover = await provider.provideHover(document, outside, token)

  // Assert
  expect(hover).toBeUndefined()
  expect(resolveDefinitionLocations).not.toHaveBeenCalled()
})

test('discards the highlight when the hover is cancelled during definition lookup', async () => {
  // Arrange
  vi.mocked(resolveDefinitionLocations).mockResolvedValueOnce([{} as vscode.Location])

  // Act
  const hover = provider.provideHover(document, position, token)
  token.isCancellationRequested = true

  // Assert
  expect(resolveDefinitionLocations).toHaveBeenCalledWith(['Api.Widget', 'Widget'], token)
  await expect(hover).resolves.toBeUndefined()
})
