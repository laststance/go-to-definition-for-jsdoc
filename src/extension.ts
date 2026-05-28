import * as vscode from 'vscode'

import { findJsDocLinkTargetAtPosition } from './jsDocLink'
import { createCandidateSymbolQueries } from './symbolName'
import { resolveDefinitionLocations } from './workspaceSymbolResolver'

const DEFINITION_PROVIDER_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
]

/**
 * Activates the JSDoc link definition provider when TypeScript or JavaScript files open.
 * @param context - VS Code extension context used to dispose registered providers.
 * @returns Nothing; provider registration is stored in `context.subscriptions`.
 * @example
 * activate(context) // registers Go to Definition support for {@link 'SymbolName'}
 */
export const activate = (context: vscode.ExtensionContext): void => {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      DEFINITION_PROVIDER_DOCUMENT_SELECTOR,
      new JsDocLinkDefinitionProvider(),
    ),
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
 * Supplies definitions for JSDoc `{@link ...}` targets without requiring an import in the current file.
 * @example
 * new JsDocLinkDefinitionProvider().provideDefinition(document, position, token) // => Location[]
 */
class JsDocLinkDefinitionProvider implements vscode.DefinitionProvider {
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

    const candidateSymbolQueries = createCandidateSymbolQueries(linkTarget.rawTarget)

    if (candidateSymbolQueries.length === 0) {
      return undefined
    }

    return resolveDefinitionLocations(candidateSymbolQueries, cancellationToken)
  }
}
