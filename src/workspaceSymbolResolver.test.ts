import type * as vscode from 'vscode'
import { beforeEach, expect, test, vi } from 'vitest'

import { createHoverDefinitionLookup, resolveDefinitionLocations } from './workspaceSymbolResolver'

const api = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  findFiles: vi.fn(),
  readFile: vi.fn(),
  changeDocument: vi.fn(),
  textDocuments: [] as Pick<vscode.TextDocument, 'uri' | 'getText' | 'isDirty'>[],
  FileSystemError: class extends Error {
    constructor(readonly code: string) { super(code) }
  },
}))

vi.mock('vscode', () => ({
  commands: { executeCommand: api.executeCommand },
  workspace: {
    createFileSystemWatcher: () => ({ onDidCreate: vi.fn(), onDidChange: vi.fn(), onDidDelete: vi.fn() }),
    onDidChangeTextDocument: api.changeDocument,
    onDidCloseTextDocument: vi.fn(),
    onDidChangeWorkspaceFolders: vi.fn(),
    onDidChangeConfiguration: vi.fn(),
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    findFiles: api.findFiles,
    textDocuments: api.textDocuments,
    fs: { readFile: api.readFile },
  },
  FileSystemError: api.FileSystemError,
  Location: class { constructor(readonly uri: vscode.Uri, readonly range: vscode.Range) {} },
  Range: class {
    readonly start = { line: 0, character: 0 }
    readonly end = { line: 0, character: 1 }
  },
}))

const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => fsPath }) as vscode.Uri
const first = uri('/src/first.ts')
const second = uri('/src/second.ts')
const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  api.textDocuments.length = 0
  api.executeCommand.mockResolvedValue([])
  api.findFiles.mockResolvedValue([first, second])
})

test('qualified hovers stop at the first indexed match and reuse it on the next request', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.executeCommand.mockResolvedValue([{ name: 'Widget', location: { uri: first } }])

  // Act
  expect(await lookup(['Api.Widget', 'Widget'], token)).toBe(true)
  expect(await lookup(['Api.Widget', 'Widget'], token)).toBe(true)

  // Assert
  expect(api.executeCommand).toHaveBeenCalledTimes(1)
  expect(api.findFiles).not.toHaveBeenCalled()
})

test('a missing hover target becomes available as soon as its declaration is typed', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.readFile.mockResolvedValue(Buffer.from(''))

  // Act
  expect(await lookup(['Widget'], token)).toBe(false)
  expect(await lookup(['Widget'], token)).toBe(false)
  const document = { uri: first, isDirty: true, getText: () => 'export class Widget {}' }
  api.textDocuments.push(document)
  api.changeDocument.mock.calls[0][0]({ document })

  // Assert
  expect(await lookup(['Widget'], token)).toBe(true)
  expect(api.findFiles).toHaveBeenCalledTimes(2)
  expect(api.readFile).toHaveBeenCalledTimes(2)
})

test('Go to Definition skips a deleted file and collects every remaining matching file', async () => {
  // Arrange
  api.findFiles.mockResolvedValue([uri('/src/deleted.ts'), second, first])
  api.readFile.mockRejectedValueOnce(new api.FileSystemError('FileNotFound'))
    .mockResolvedValue(Buffer.from('export class Widget {}'))

  // Act
  const locations = await resolveDefinitionLocations(['Widget'], token)

  // Assert
  expect(locations.map(location => location.uri.fsPath)).toEqual(['/src/first.ts', '/src/second.ts'])
})

test('permission failures propagate from the source scan', async () => {
  // Arrange
  const denied = new api.FileSystemError('NoPermissions')
  api.readFile.mockRejectedValue(denied)

  // Act
  const locations = resolveDefinitionLocations(['Widget'], token)

  // Assert
  await expect(locations).rejects.toBe(denied)
})

test('an edit during lookup prevents an obsolete match from highlighting the next hover', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.executeCommand.mockImplementationOnce(() => {
    api.changeDocument.mock.calls[0][0]({ document: { uri: first } })
    return [{ name: 'Widget', location: { uri: first } }]
  })
  api.findFiles.mockResolvedValue([])

  // Act
  const duringEdit = await lookup(['Widget'], token)
  const afterEdit = await lookup(['Widget'], token)

  // Assert
  expect([duringEdit, afterEdit]).toEqual([false, false])
  expect(api.executeCommand).toHaveBeenCalledTimes(2)
})

test('an initially missing symbol can be highlighted once the workspace index warms up', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.findFiles.mockResolvedValue([])
  api.executeCommand.mockResolvedValueOnce([]).mockResolvedValue([{ name: 'Widget', location: { uri: first } }])
  vi.useFakeTimers()

  try {
    // Act
    const beforeIndexing = await lookup(['Widget'], token)
    vi.advanceTimersByTime(5_001)
    const afterIndexing = await lookup(['Widget'], token)

    // Assert
    expect([beforeIndexing, afterIndexing]).toEqual([false, true])
    expect(api.findFiles).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

test('retrying an unresolved hover checks the index without rereading unchanged files', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.readFile.mockResolvedValue(Buffer.from('export class Other {}'))
  vi.useFakeTimers()

  try {
    // Act
    const firstHover = await lookup(['Widget'], token)
    vi.advanceTimersByTime(5_001)
    const repeatedHover = await lookup(['Widget'], token)

    // Assert
    expect([firstHover, repeatedHover]).toEqual([false, false])
    expect(api.executeCommand).toHaveBeenCalledTimes(2)
    expect(api.findFiles).toHaveBeenCalledTimes(1)
    expect(api.readFile).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
