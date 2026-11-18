import type * as vscode from 'vscode'
import { beforeEach, expect, test, vi } from 'vitest'

import { activate } from './extension'
import { resolveDefinitionLocations } from './workspaceSymbolResolver'

const { hasDefinition, registerDefinitionProvider, registerHoverProvider } = vi.hoisted(() => ({
  hasDefinition: vi.fn<(names: readonly string[], token: vscode.CancellationToken) => Promise<boolean>>(),
  registerDefinitionProvider: vi.fn<typeof vscode.languages.registerDefinitionProvider>(),
  registerHoverProvider: vi.fn<typeof vscode.languages.registerHoverProvider>(),
}))

vi.mock('vscode', () => ({
  languages: { registerDefinitionProvider, registerHoverProvider },
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

vi.mock('./workspaceSymbolResolver', () => ({
  createHoverDefinitionLookup: () => hasDefinition,
  resolveDefinitionLocations: vi.fn(),
}))

const linkLine = " * {@link '  Api.Widget()  ' | help}"
const source = ['/**', ' * Widget documentation.', ' *', linkLine, ' */'].join('\n')
const linkDocument: Pick<vscode.TextDocument, 'fileName' | 'version' | 'lineAt' | 'getText' | 'offsetAt'> = {
  fileName: 'usage.ts',
  version: 1,
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
  hasDefinition.mockResolvedValueOnce(true)

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
  hasDefinition.mockResolvedValueOnce(false)

  // Act
  const hover = await provider.provideHover(document, position, token)

  // Assert
  expect(hover).toBeUndefined()
})

test.each([
  ['the leading space', 11],
  ['the opening parenthesis', 23],
  ['the closing parenthesis', 24],
  ['the trailing space', 25],
  ['the closing quote', 27],
  ['the link label', 31],
])('leaves %s unhighlighted without starting a definition search', async (_, character) => {
  // Arrange
  const outside = { line: 3, character } as vscode.Position

  // Act
  const hover = await provider.provideHover(document, outside, token)

  // Assert
  expect(hover).toBeUndefined()
  expect(hasDefinition).not.toHaveBeenCalled()
})

test('discards the highlight when the hover is cancelled during definition lookup', async () => {
  // Arrange
  hasDefinition.mockResolvedValueOnce(true)

  // Act
  const hover = provider.provideHover(document, position, token)
  token.isCancellationRequested = true

  // Assert
  expect(hasDefinition).toHaveBeenCalledWith(['Api.Widget', 'Widget'], token)
  await expect(hover).resolves.toBeUndefined()
})

test('navigates to the definition from a decorative call parenthesis', async () => {
  // Arrange
  const definitionProvider = registerDefinitionProvider.mock.calls[0][1]
  const locations = [{} as vscode.Location]
  vi.mocked(resolveDefinitionLocations).mockResolvedValueOnce(locations)

  // Act
  const definition = await definitionProvider.provideDefinition(
    document,
    { line: 3, character: 23 } as vscode.Position,
    token,
  )

  // Assert
  expect(definition).toEqual(locations)
  expect(resolveDefinitionLocations).toHaveBeenCalledWith(['Api.Widget', 'Widget'], token)
})
