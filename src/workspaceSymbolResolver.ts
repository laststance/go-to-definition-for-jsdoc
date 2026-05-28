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

/**
 * Resolves candidate symbol names to definition locations across the active VS Code workspace.
 * @param candidateSymbolNames - Exact symbol names derived from a JSDoc link target.
 * @param cancellationToken - VS Code cancellation token for editor navigation requests.
 * @returns Matching definition locations, ordered by VS Code workspace symbols first and AST fallback second.
 * @example
 * resolveDefinitionLocations(["useThing"], token) // => [Location(...)]
 */
export const resolveDefinitionLocations = async (
  candidateSymbolNames: readonly string[],
  cancellationToken: vscode.CancellationToken,
): Promise<vscode.Location[]> => {
  const workspaceSymbolLocations = await resolveWorkspaceSymbolLocations(candidateSymbolNames, cancellationToken)

  if (workspaceSymbolLocations.length > 0 || cancellationToken.isCancellationRequested) {
    return workspaceSymbolLocations
  }

  const extensionConfiguration = getExtensionConfiguration()

  if (!extensionConfiguration.enableSourceScanFallback) {
    return []
  }

  return resolveSourceScanLocations(candidateSymbolNames, extensionConfiguration.maxSourceScanFiles, cancellationToken)
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
): Promise<vscode.Location[]> => {
  const sourceFileUris = await vscode.workspace.findFiles(
    SOURCE_FILE_GLOB,
    DEFAULT_IGNORED_WORKSPACE_GLOB,
    maxSourceScanFiles,
    cancellationToken,
  )
  const locations: vscode.Location[] = []

  for (const sourceFileUri of sourceFileUris) {
    if (cancellationToken.isCancellationRequested) {
      break
    }

    if (!isSupportedSourceFileUri(sourceFileUri)) {
      continue
    }

    const sourceText = await readWorkspaceFileAsUtf8(sourceFileUri)
    const sourceDefinitions = findSymbolDefinitionsInSourceText({
      fileName: sourceFileUri.fsPath,
      sourceText,
      candidateNames: candidateSymbolNames,
    })

    for (const sourceDefinition of sourceDefinitions) {
      locations.push(
        new vscode.Location(
          sourceFileUri,
          new vscode.Range(
            sourceDefinition.startLine,
            sourceDefinition.startCharacter,
            sourceDefinition.endLine,
            sourceDefinition.endCharacter,
          ),
        ),
      )
    }
  }

  return takeFirstDefinitions(deduplicateLocations(locations))
}

/**
 * Reads a workspace file through VS Code's filesystem API so remote workspaces still work.
 * @param fileUri - The source file URI to read.
 * @returns UTF-8 source text.
 * @example
 * readWorkspaceFileAsUtf8(Uri.file("src/a.ts")) // => "export const a = 1"
 */
const readWorkspaceFileAsUtf8 = async (fileUri: vscode.Uri): Promise<string> => {
  const fileBytes = await vscode.workspace.fs.readFile(fileUri)

  return Buffer.from(fileBytes).toString('utf8')
}

/**
 * Reads extension settings and clamps numeric limits before a fallback scan begins.
 * @returns The active extension configuration.
 * @example
 * getExtensionConfiguration().enableSourceScanFallback // => true
 */
const getExtensionConfiguration = (): ExtensionConfiguration => {
  const configuration = vscode.workspace.getConfiguration('tsLink')
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
