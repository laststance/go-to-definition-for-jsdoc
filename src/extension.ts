import * as vscode from 'vscode'

import { findJsDocLinkTargetAtPosition } from './jsDocLink'
import { isSourceCommentAtOffset } from './sourceComment'
import { createCandidateSymbolQueries } from './symbolName'
import { resolveDefinitionLocations } from './workspaceSymbolResolver'

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
  const provider = new JsDocLinkProvider()

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
 * new JsDocLinkProvider().provideDefinition(document, position, token)
 */
class JsDocLinkProvider implements vscode.DefinitionProvider, vscode.HoverProvider {
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

    if (!linkTarget) {
      return undefined
    }

    return this.resolveTarget(linkTarget.rawTarget, cancellationToken)
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

    // Quoted targets can contain padding. Only the symbol text is hoverable.
    const targetText = currentLineText.slice(linkTarget.targetStartCharacter, linkTarget.targetEndCharacter)
    const startCharacter = linkTarget.targetStartCharacter + targetText.indexOf(linkTarget.rawTarget)
    const endCharacter = startCharacter + linkTarget.rawTarget.length
    if (position.character < startCharacter || position.character >= endCharacter) {
      return undefined
    }

    if (!isSourceCommentAtOffset(document.fileName, document.getText(), document.offsetAt(position))) {
      return undefined
    }

    const locations = await this.resolveTarget(linkTarget.rawTarget, cancellationToken)

    if (cancellationToken.isCancellationRequested || !locations?.length) {
      return undefined
    }

    const targetRange = new vscode.Range(position.line, startCharacter, position.line, endCharacter)
    return new vscode.Hover('Go to Definition', targetRange)
  }

  /**
   * Shares workspace symbol lookup between {@link provideDefinition} and {@link provideHover}.
   * @example
   * this.resolveTarget('useThing', token)
   */
  private resolveTarget(
    rawTarget: string,
    cancellationToken: vscode.CancellationToken,
  ): Promise<vscode.Location[]> | undefined {
    if (cancellationToken.isCancellationRequested) {
      return undefined
    }

    const candidateSymbolQueries = createCandidateSymbolQueries(rawTarget)

    if (candidateSymbolQueries.length === 0) {
      return undefined
    }

    return resolveDefinitionLocations(candidateSymbolQueries, cancellationToken)
  }
}
