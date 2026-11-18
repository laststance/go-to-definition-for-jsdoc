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
    readonly start
    readonly end

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter }
      this.end = { line: endLine, character: endCharacter }
    }
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

test('hover finds an external addition and forgets its removal even without watcher events', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.findFiles.mockResolvedValue([first])
  api.readFile.mockResolvedValue(Buffer.from(''))
  vi.useFakeTimers()
  try {
    // Act
    expect(await lookup(['Widget'], token)).toBe(false)
    api.readFile.mockResolvedValue(Buffer.from('export class Widget {}'))
    vi.advanceTimersByTime(59_999)
    expect(await lookup(['Widget'], token)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await lookup(['Widget'], token)).toBe(true)
    api.readFile.mockResolvedValue(Buffer.from(''))
    vi.advanceTimersByTime(59_999)
    expect(await lookup(['Widget'], token)).toBe(true)
    vi.advanceTimersByTime(1)

    // Assert
    expect(await lookup(['Widget'], token)).toBe(false)
    expect(api.findFiles).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

test.each([true, false])('a delayed hover respects the newer result when the newer hover found = %s', async newerFound => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  const match = [{ name: 'Widget', location: { uri: first } }]
  let finishOlder!: (symbols: typeof match) => void
  api.executeCommand.mockReturnValueOnce(new Promise<typeof match>(resolve => { finishOlder = resolve }))
    .mockResolvedValueOnce(newerFound ? match : [])
  api.findFiles.mockResolvedValue([])

  // Act
  const older = lookup(['Widget'], token)
  const newer = await lookup(['Widget'], token)
  finishOlder(newerFound ? [] : match)

  // Assert
  expect(newer).toBe(newerFound)
  expect(await older).toBe(newerFound)
  expect(await lookup(['Widget'], token)).toBe(newerFound)
  expect(api.executeCommand).toHaveBeenCalledTimes(2)
})

test('a cancelled newer hover preserves the pending match and caches it for the next hover', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  const match = [{ name: 'Widget', location: { uri: first } }]
  const newerToken = { ...token }
  let finishOlder!: (symbols: typeof match) => void
  api.executeCommand.mockReturnValueOnce(new Promise<typeof match>(resolve => { finishOlder = resolve }))

  // Act
  const older = lookup(['Widget'], token)
  const newer = lookup(['Widget'], newerToken)
  newerToken.isCancellationRequested = true
  const cancelled = await newer
  finishOlder(match)
  const delayed = await older
  const repeated = await lookup(['Widget'], token)

  // Assert
  expect([cancelled, delayed, repeated]).toEqual([false, true, true])
  expect(api.executeCommand).toHaveBeenCalledTimes(2)
})

test('an evicted hover result cannot be replaced by an older pending match', async () => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  const match = [{ name: 'Widget', location: { uri: first } }]
  let finishOlder!: (symbols: typeof match) => void
  api.executeCommand.mockReturnValueOnce(new Promise<typeof match>(resolve => { finishOlder = resolve }))
  api.findFiles.mockResolvedValue([])

  // Act
  const older = lookup(['Widget'], token)
  const newer = await lookup(['Widget'], token)
  // Fill the bounded cache to evict its first entry, the newer Widget result.
  for (let index = 0; index < 256; index++) {
    await lookup([`Other${index}`], token)
  }
  finishOlder(match)
  const delayed = await older
  const next = await lookup(['Widget'], token)

  // Assert
  expect([newer, delayed, next]).toEqual([false, false, false])
  expect(api.executeCommand).toHaveBeenLastCalledWith('vscode.executeWorkspaceSymbolProvider', 'Widget')
  expect(api.executeCommand).toHaveBeenCalledTimes(259)
})

test('F12 reads edits made to both the current and the next file during a pending disk read', async () => {
  // Arrange
  api.readFile.mockImplementationOnce(async () => {
    await Promise.resolve()
    api.textDocuments.push(
      { uri: first, isDirty: true, getText: () => '\nexport class Widget {}' },
      { uri: second, isDirty: true, getText: () => '\n\n  class Widget {}' },
    )
    return Buffer.from('')
  })

  // Act
  const locations = await resolveDefinitionLocations(['Widget'], token)

  // Assert
  expect(locations.map(({ uri, range }) => [uri.fsPath, range.start, range.end])).toEqual([
    ['/src/first.ts', { line: 1, character: 13 }, { line: 1, character: 19 }],
    ['/src/second.ts', { line: 2, character: 8 }, { line: 2, character: 14 }],
  ])
  expect(api.readFile).toHaveBeenCalledTimes(1)
})

test('F12 drops an unsaved declaration reverted while reading another file', async () => {
  // Arrange
  const document = { uri: first, isDirty: true, getText: () => 'export class Widget {}' }
  api.textDocuments.push(document)
  api.readFile.mockImplementationOnce(async () => {
    document.isDirty = false
    document.getText = () => 'export class Other {}'
    return Buffer.from('export class Widget {}')
  })

  // Act
  const locations = await resolveDefinitionLocations(['Widget'], token)

  // Assert
  expect(locations.map(location => location.uri.fsPath)).toEqual(['/src/second.ts'])
})

test.each(['before', 'after'])('hover and F12 find a target when an unreadable file occurs %s it', async order => {
  // Arrange
  const lookup = createHoverDefinitionLookup({ subscriptions: [] })
  api.findFiles.mockResolvedValue(order === 'before' ? [second, first] : [first, second])
  api.readFile.mockImplementation(async (file: vscode.Uri) => {
    if (file === second) throw new api.FileSystemError('NoPermissions')
    return Buffer.from('class Widget {}')
  })

  // Act
  const hover = await lookup(['Widget'], token)
  const navigation = await resolveDefinitionLocations(['Widget'], token)

  // Assert
  expect(hover).toBe(true)
  expect(navigation.map(location => location.uri.fsPath)).toEqual(['/src/first.ts'])
})

test.each(['first', 'all'] as const)('%s resolves a clean open buffer without reading disk', async mode => {
  // Arrange
  api.findFiles.mockResolvedValue([first])
  api.textDocuments.push({ uri: first, isDirty: false, getText: () => 'class Widget {}' })

  // Act
  const locations = await resolveDefinitionLocations(['Widget'], token, mode)

  // Assert
  expect(locations.map(location => location.uri.fsPath)).toEqual(['/src/first.ts'])
  expect(api.readFile).not.toHaveBeenCalled()
})

test('F12 recovers successive closed buffers from disk and uses the latest open editor text', async () => {
  // Arrange
  const third = uri('/src/third.ts')
  const fourth = uri('/src/fourth.ts')
  const remaining = { uri: third, isDirty: true, getText: () => '' }
  let secondOnDisk = 'class Widget {}'
  api.findFiles.mockResolvedValue([second, first, third, fourth])
  api.textDocuments.push(
    { uri: first, isDirty: true, getText: () => 'class Old {}' },
    { uri: second, isDirty: true, getText: () => 'class Widget {}' },
    remaining,
  )
  api.readFile.mockImplementation(async (file: vscode.Uri) => {
    if (file === fourth) api.textDocuments.shift()
    if (file === first) {
      // Save the second buffer at a new location and close it during recovery.
      secondOnDisk = '\n\nclass Widget {}'
      api.textDocuments.shift()
    }
    if (file === second) return Buffer.from(secondOnDisk)
    remaining.getText = () => 'class Widget {}'
    return Buffer.from(file === first ? 'class Widget {}' : '')
  })

  // Act
  const locations = await resolveDefinitionLocations(['Widget'], token)

  // Assert
  expect(locations.map(({ uri, range }) => [uri.fsPath, range.start])).toEqual([
    ['/src/first.ts', { line: 0, character: 6 }],
    ['/src/second.ts', { line: 2, character: 6 }],
    ['/src/third.ts', { line: 0, character: 6 }],
  ])
  expect(api.readFile.mock.calls.map(([file]) => file.fsPath)).toEqual([
    '/src/fourth.ts', '/src/first.ts', '/src/second.ts',
  ])
})
