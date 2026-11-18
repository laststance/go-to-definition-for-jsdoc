import * as path from 'node:path'
import * as vscode from 'vscode'

import {
  DEFAULT_IGNORED_WORKSPACE_GLOB,
  IGNORED_WORKSPACE_DIRECTORY_NAMES,
  MAX_DEFINITION_RESULTS,
  MAX_SOURCE_SCAN_FILES,
  MIN_SOURCE_SCAN_FILES,
  SOURCE_FILE_GLOB,
  SUPPORTED_SOURCE_FILE_EXTENSIONS,
} from './constants'
import { findSymbolDefinitionsInSourceText } from './sourceSymbolParser'

type ExtensionConfiguration = {
  readonly enableSourceScanFallback: boolean
  readonly maxSourceScanFiles: number
}

type LookupMode = 'first' | 'all'
const MAX_HOVER_CACHE_ENTRIES = 256
const SYMBOL_INDEX_RETRY_MS = 5_000
const FULL_LOOKUP_RETRY_MS = 60_000

type HoverCacheEntry = {
  found: boolean
  indexRetryAt: number
  fullRetryAt: number
}

/**
 * Creates the symbol-existence check used by the hover provider during activation.
 * Repeated hovers share completed results until an edit or periodic revalidation.
 * @example
 * const hasDefinition = createHoverDefinitionLookup(context)
 */
export const createHoverDefinitionLookup = (context: Pick<vscode.ExtensionContext, 'subscriptions'>) => {
  const cache = new Map<string, HoverCacheEntry>()
  const pending = new Map<string, {
    active: number
    nextOrder: number
    completed?: { order: number; found: boolean }
  }>()
  const invalidate = () => {
    cache.clear()
    pending.clear()
  }
  const invalidateSource = (uri: vscode.Uri) => {
    if (isSupportedSourceFileUri(uri)) {
      invalidate()
    }
  }
  const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_FILE_GLOB)
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(invalidateSource),
    watcher.onDidChange(invalidateSource),
    watcher.onDidDelete(invalidateSource),
    vscode.workspace.onDidOpenTextDocument(document => invalidateSource(document.uri)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => invalidateSource(document.uri)),
    vscode.workspace.onDidCloseTextDocument(document => invalidateSource(document.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration(invalidate),
  )

  return async (candidateNames: readonly string[], token: vscode.CancellationToken): Promise<boolean> => {
    if (token.isCancellationRequested || !candidateNames.length) {
      return false
    }
    const key = JSON.stringify(candidateNames)
    const cached = cache.get(key)
    const now = Date.now()
    const needsFullLookup = !cached || now >= cached.fullRetryAt
    if (!needsFullLookup && (cached.found || now < cached.indexRetryAt)) {
      return cached.found
    }

    // Retain the newest completed answer while overlapping requests can still publish.
    const group = pending.get(key) ?? { active: 0, nextOrder: 0 }
    pending.set(key, group)
    group.active++
    const order = group.nextOrder++
    try {
      // Retry misses against a warming index between full checks for unobserved filesystem changes.
      const locations = needsFullLookup
        ? await resolveDefinitionLocations(candidateNames, token, 'first')
        : await resolveWorkspaceSymbolLocations(candidateNames, token, 'first')
      // An edit or cancellation during the lookup makes its answer obsolete.
      if (token.isCancellationRequested || pending.get(key) !== group) {
        return false
      }
      if (group.completed && group.completed.order > order) {
        return group.completed.found
      }

      const found = locations.length > 0
      group.completed = { order, found }
      if (!cache.has(key) && cache.size >= MAX_HOVER_CACHE_ENTRIES) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      const completedAt = Date.now()
      cache.set(key, {
        found,
        indexRetryAt: completedAt + SYMBOL_INDEX_RETRY_MS,
        fullRetryAt: needsFullLookup ? completedAt + FULL_LOOKUP_RETRY_MS : cached.fullRetryAt,
      })
      return found
    } finally {
      // Invalidation may already have started another group for this key.
      group.active--
      if (group.active === 0 && pending.get(key) === group) {
        pending.delete(key)
      }
    }
  }
}

/**
 * Resolves candidate symbol names to definition locations across the active VS Code workspace.
 * @param candidateSymbolNames - Exact symbol names derived from a JSDoc link target.
 * @param cancellationToken - VS Code cancellation token for editor navigation requests.
 * @param mode - Hover stops at the first match. Navigation collects all matching locations up to the result limit.
 * @returns Matching definition locations, ordered by VS Code workspace symbols first and AST fallback second.
 * @example
 * resolveDefinitionLocations(["useThing"], token) // => [Location(...)]
 */
export const resolveDefinitionLocations = async (
  candidateSymbolNames: readonly string[],
  cancellationToken: vscode.CancellationToken,
  mode: LookupMode = 'all',
): Promise<vscode.Location[]> => {
  const workspaceSymbolLocations = await resolveWorkspaceSymbolLocations(candidateSymbolNames, cancellationToken, mode)

  if (workspaceSymbolLocations.length > 0 || cancellationToken.isCancellationRequested) {
    return workspaceSymbolLocations
  }

  const extensionConfiguration = getExtensionConfiguration()

  if (!extensionConfiguration.enableSourceScanFallback) {
    return []
  }

  return resolveSourceScanLocations(candidateSymbolNames, extensionConfiguration.maxSourceScanFiles, cancellationToken, mode)
}

/**
 * Uses VS Code's built-in workspace symbol index as the first and fastest lookup source.
 * @param candidateSymbolNames - Exact symbol names to query.
 * @param cancellationToken - VS Code cancellation token for editor navigation requests.
 * @returns Definition locations reported by workspace symbol providers.
 * @example
 * resolveWorkspaceSymbolLocations(["ReadableItem"], token) // => [Location(...)]
 */
const resolveWorkspaceSymbolLocations = async (
  candidateSymbolNames: readonly string[],
  cancellationToken: vscode.CancellationToken,
  mode: LookupMode,
): Promise<vscode.Location[]> => {
  const candidateNameSet = new Set(candidateSymbolNames)
  const locations: vscode.Location[] = []

  for (const candidateSymbolName of candidateSymbolNames) {
    if (cancellationToken.isCancellationRequested) {
      break
    }

    const workspaceSymbols =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        candidateSymbolName,
      )) ?? []

    for (const workspaceSymbol of workspaceSymbols) {
      if (!candidateNameSet.has(workspaceSymbol.name) || !isSupportedSourceFileUri(workspaceSymbol.location.uri)) {
        continue
      }

      // A hover only needs evidence of one matching definition.
      if (mode === 'first') return [workspaceSymbol.location]
      locations.push(workspaceSymbol.location)
    }
  }

  return takeFirstDefinitions(deduplicateLocations(locations))
}

/**
 * Scans source files with the TypeScript AST when the workspace symbol provider cannot resolve a link.
 * @param candidateSymbolNames - Exact symbol names to find.
 * @param maxSourceScanFiles - Maximum number of files to inspect.
 * @param cancellationToken - VS Code cancellation token for editor navigation requests.
 * @returns Definition locations found by parsing source files.
 * @example
 * resolveSourceScanLocations(["LocalType"], 2000, token) // => [Location(...)]
 */
const resolveSourceScanLocations = async (
  candidateSymbolNames: readonly string[],
  maxSourceScanFiles: number,
  cancellationToken: vscode.CancellationToken,
  mode: LookupMode,
): Promise<vscode.Location[]> => {
  const sourceFileUris = await vscode.workspace.findFiles(
    SOURCE_FILE_GLOB,
    DEFAULT_IGNORED_WORKSPACE_GLOB,
    maxSourceScanFiles,
    cancellationToken,
  )
  const diskLocations = new Map<vscode.Uri, vscode.Location[]>()
  const deferred = new Set<vscode.Uri>()
  const readErrors = new Map<vscode.Uri, unknown>()
  const openDocument = (uri: vscode.Uri) => vscode.workspace.textDocuments.find(document =>
    document.uri.toString() === uri.toString(),
  )
  const parseLocations = (uri: vscode.Uri, sourceText: string) => findSymbolDefinitionsInSourceText({
    fileName: uri.fsPath,
    sourceText,
    candidateNames: candidateSymbolNames,
  }).map(definition => new vscode.Location(uri, new vscode.Range(
    definition.startLine, definition.startCharacter, definition.endLine, definition.endCharacter,
  )))

  const saved = new Map<string, { text: string }>()
  const readDisk = async (uri: vscode.Uri) => {
    const key = uri.toString()
    const beforeRead = saved.get(key)
    let bytes: Uint8Array
    try {
      bytes = await vscode.workspace.fs.readFile(uri)
    } catch (error) {
      // Keep scanning other files, but surface the first failure if none can resolve the symbol.
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        if (saved.get(key) === beforeRead) saved.delete(key)
      } else {
        readErrors.set(uri, error)
      }
      return []
    }
    // A successful read supersedes an earlier save unless another save raced the read.
    if (saved.get(key) !== beforeRead) return []
    saved.delete(key)
    return cancellationToken.isCancellationRequested ? [] : parseLocations(uri, Buffer.from(bytes).toString('utf8'))
  }

  const eligible = mode === 'all' ? new Set(sourceFileUris.filter(isSupportedSourceFileUri).map(uri => uri.toString())) : undefined
  const saveListener = eligible && vscode.workspace.onDidSaveTextDocument(document => {
    const key = document.uri.toString()
    if (eligible.has(key)) saved.set(key, { text: document.getText() })
  })
  try {
    for (const uri of sourceFileUris) {
      if (cancellationToken.isCancellationRequested) return []
      if (!isSupportedSourceFileUri(uri)) continue

      const document = openDocument(uri)
      if (mode === 'first') {
        // A pending read can finish after an editor has opened or changed the file.
        const disk = document ? [] : await readDisk(uri)
        if (cancellationToken.isCancellationRequested) return []
        const current = document ?? openDocument(uri)
        if (current) readErrors.delete(uri)
        const [first] = current ? parseLocations(uri, current.getText()) : disk
        if (first) return [first]
      } else if (document) {
        deferred.add(uri)
      } else {
        diskLocations.set(uri, await readDisk(uri))
      }
    }

    if (cancellationToken.isCancellationRequested) return []
    if (mode === 'first') {
      if (readErrors.size) throw readErrors.values().next().value
      return []
    }
    const snapshot = () => new Map(vscode.workspace.textDocuments.map(document => [document.uri.toString(), document]))
    let open = snapshot()
    // A buffer can close during recovery, so reconsider the remaining files after each read.
    while (deferred.size) {
      let closed: vscode.Uri | undefined
      for (const uri of deferred) {
        if (!open.has(uri.toString())) {
          closed = uri
          break
        }
      }
      if (!closed) break
      deferred.delete(closed)
      diskLocations.set(closed, await readDisk(closed))
      if (cancellationToken.isCancellationRequested) return []
      open = snapshot()
    }
    if (cancellationToken.isCancellationRequested) return []

    // Prefer the current buffer, then the latest editor save, then the completed disk read.
    const locations: vscode.Location[] = []
    for (const uri of sourceFileUris) {
      if (!isSupportedSourceFileUri(uri)) continue
      const document = open.get(uri.toString())
      const sourceText = document?.getText() ?? saved.get(uri.toString())?.text
      if (sourceText !== undefined) readErrors.delete(uri)
      locations.push(...(sourceText !== undefined ? parseLocations(uri, sourceText) : diskLocations.get(uri) ?? []))
    }
    if (!locations.length && readErrors.size) throw readErrors.values().next().value
    return takeFirstDefinitions(deduplicateLocations(locations))
  } finally {
    saveListener?.dispose()
  }
}

/**
 * Reads extension settings and clamps numeric limits before a fallback scan begins.
 * @returns The active extension configuration.
 * @example
 * getExtensionConfiguration().enableSourceScanFallback // => true
 */
const getExtensionConfiguration = (): ExtensionConfiguration => {
  const configuration = vscode.workspace.getConfiguration('go-to-definition-for-jsdoc')
  const configuredMaxSourceScanFiles = configuration.get<number>('maxSourceScanFiles', MAX_SOURCE_SCAN_FILES)

  return {
    enableSourceScanFallback: configuration.get<boolean>('enableSourceScanFallback', true),
    maxSourceScanFiles: Math.max(MIN_SOURCE_SCAN_FILES, configuredMaxSourceScanFiles),
  }
}

/**
 * Filters URIs to source files that are useful definition targets.
 * @param fileUri - A URI returned by VS Code symbol or file APIs.
 * @returns `true` when the URI points to a supported source file outside ignored directories.
 * @example
 * isSupportedSourceFileUri(Uri.file("src/a.ts")) // => true
 */
const isSupportedSourceFileUri = (fileUri: vscode.Uri): boolean => {
  if (fileUri.scheme !== 'file') {
    return false
  }

  if (!SUPPORTED_SOURCE_FILE_EXTENSIONS.includes(path.extname(fileUri.fsPath) as (typeof SUPPORTED_SOURCE_FILE_EXTENSIONS)[number])) {
    return false
  }

  const pathSegments = fileUri.fsPath.split(path.sep)

  return !pathSegments.some((pathSegment) =>
    IGNORED_WORKSPACE_DIRECTORY_NAMES.includes(pathSegment as (typeof IGNORED_WORKSPACE_DIRECTORY_NAMES)[number]),
  )
}

/**
 * Removes duplicate locations that can be returned by multiple symbol candidates.
 * @param locations - Raw definition locations from workspace and fallback lookups.
 * @returns Unique definition locations ordered by file path and range.
 * @example
 * deduplicateLocations([location, location]) // => [location]
 */
const deduplicateLocations = (locations: readonly vscode.Location[]): vscode.Location[] => {
  const seenLocationKeys = new Set<string>()
  const uniqueLocations: vscode.Location[] = []

  for (const location of locations) {
    const locationKey = createLocationKey(location)

    if (seenLocationKeys.has(locationKey)) {
      continue
    }

    seenLocationKeys.add(locationKey)
    uniqueLocations.push(location)
  }

  return uniqueLocations.sort(compareLocations)
}

/**
 * Limits the number of definitions returned to keep Go to Definition menus readable.
 * @param locations - Unique sorted definition locations.
 * @returns The first supported definition results.
 * @example
 * takeFirstDefinitions(locations).length <= 20 // => true
 */
const takeFirstDefinitions = (locations: readonly vscode.Location[]): vscode.Location[] => {
  return locations.slice(0, MAX_DEFINITION_RESULTS)
}

/**
 * Creates a stable identity key for a definition location.
 * @param location - A VS Code location.
 * @returns A string key made from URI and range coordinates.
 * @example
 * createLocationKey(location) // => "file:///src/a.ts:1:7"
 */
const createLocationKey = (location: vscode.Location): string => {
  return [
    location.uri.toString(),
    location.range.start.line,
    location.range.start.character,
    location.range.end.line,
    location.range.end.character,
  ].join(':')
}

/**
 * Sorts definition locations in a stable path-first order.
 * @param leftLocation - The left location to compare.
 * @param rightLocation - The right location to compare.
 * @returns A negative, zero, or positive sort result.
 * @example
 * compareLocations(firstLocation, secondLocation) // => -1
 */
const compareLocations = (leftLocation: vscode.Location, rightLocation: vscode.Location): number => {
  const uriComparison = leftLocation.uri.fsPath.localeCompare(rightLocation.uri.fsPath)

  if (uriComparison !== 0) {
    return uriComparison
  }

  const startLineComparison = leftLocation.range.start.line - rightLocation.range.start.line

  if (startLineComparison !== 0) {
    return startLineComparison
  }

  return leftLocation.range.start.character - rightLocation.range.start.character
}
