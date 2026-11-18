import * as vscode from 'vscode'

import { findJsDocLinkTargetAtPosition } from './jsDocLink'
import { isSourceCommentAtOffset } from './sourceComment'
import { createCandidateSymbolQueries } from './symbolName'
import { createHoverDefinitionLookup, resolveDefinitionLocations } from './workspaceSymbolResolver'

const JSDOC_LINK_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
]

/**
 * Registers navigation and hover for JSDoc links when TypeScript or JavaScript files open.
 * @param context - VS Code extension context used to dispose registered providers.
 * @example
 * activate(context)
 */
export const activate = (context: vscode.ExtensionContext): void => {
  const provider = new JsDocLinkProvider(createHoverDefinitionLookup(context))

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(JSDOC_LINK_DOCUMENT_SELECTOR, provider),
    vscode.languages.registerHoverProvider(JSDOC_LINK_DOCUMENT_SELECTOR, provider),
  )
}

/**
 * Cleans up extension resources when VS Code deactivates this extension.
 * @returns Nothing because all disposables are owned by VS Code subscriptions.
 * @example
 * deactivate() // => undefined
 */
export const deactivate = (): void => undefined

/**
 * Gives VS Code a shared symbol lookup for navigating and highlighting JSDoc links.
 * @example
 * new JsDocLinkProvider(createHoverDefinitionLookup(context)).provideDefinition(document, position, token)
 */
class JsDocLinkProvider implements vscode.DefinitionProvider, vscode.HoverProvider {
  constructor(private readonly hasDefinition: ReturnType<typeof createHoverDefinitionLookup>) {}

  /**
   * Resolves the link target under the cursor to workspace symbol definition locations.
   * @param document - The active text document where Go to Definition was triggered.
   * @param position - The cursor position used by VS Code definition lookup.
   * @param cancellationToken - VS Code cancellation token for navigation requests.
   * @returns
   * - Definition locations when the cursor is inside a supported JSDoc link target
   * - `undefined` when this provider should not handle the current cursor position
   * @example
   * provider.provideDefinition(document, positionInsideLink, token) // => [Location(...)]
   */
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken: vscode.CancellationToken,
  ): Promise<vscode.Definition | undefined> {
    const currentLineText = document.lineAt(position.line).text
    const linkTarget = findJsDocLinkTargetAtPosition(currentLineText, position.character)

    if (!linkTarget || cancellationToken.isCancellationRequested) {
      return undefined
    }

    const candidates = createCandidateSymbolQueries(linkTarget.rawTarget)
    if (candidates.length === 0) {
      return undefined
    }

    return resolveDefinitionLocations(candidates, cancellationToken)
  }

  /**
   * Returns a native VS Code hover so pointing at a resolvable link highlights its target text.
   * @param cancellationToken - Cancelled by VS Code when the hover request is no longer current.
   * @example
   * provider.provideHover(document, positionInsideLink, token)
   */
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const currentLineText = document.lineAt(position.line).text
    const linkTarget = findJsDocLinkTargetAtPosition(currentLineText, position.character)

    if (!linkTarget?.rawTarget || cancellationToken.isCancellationRequested) {
      return undefined
    }

    // The first query retains the qualified name and strips JSDoc call and type suffixes.
    const candidates = createCandidateSymbolQueries(linkTarget.rawTarget)
    const [symbolName] = candidates
    if (!symbolName) {
      return undefined
    }

    const targetText = currentLineText.slice(linkTarget.targetStartCharacter, linkTarget.targetEndCharacter)
    const startCharacter = linkTarget.targetStartCharacter + targetText.indexOf(symbolName)
    const endCharacter = startCharacter + symbolName.length
    if (position.character < startCharacter || position.character >= endCharacter) {
      return undefined
    }

    if (!isSourceCommentAtOffset(document, document.offsetAt(position))) {
      return undefined
    }

    const hasDefinition = await this.hasDefinition(candidates, cancellationToken)

    if (cancellationToken.isCancellationRequested || !hasDefinition) {
      return undefined
    }

    const targetRange = new vscode.Range(position.line, startCharacter, position.line, endCharacter)
    return new vscode.Hover('Go to Definition', targetRange)
  }
}
