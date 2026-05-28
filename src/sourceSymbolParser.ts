import * as ts from 'typescript'

export type SourceSymbolDefinition = {
  readonly symbolName: string
  readonly startLine: number
  readonly startCharacter: number
  readonly endLine: number
  readonly endCharacter: number
}

type FindSymbolDefinitionsParams = {
  readonly fileName: string
  readonly sourceText: string
  readonly candidateNames: readonly string[]
}

type NamedIdentifierDeclaration = (
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration
  | ts.MethodDeclaration
  | ts.PropertyDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.EnumMember
) & {
  readonly name: ts.Identifier
}

/**
 * Finds TypeScript declaration names that match unresolved JSDoc link targets.
 * @param params - File text, file name, and candidate symbol names to match.
 * @returns Matching declaration ranges in zero-based line and character coordinates.
 * @example
 * findSymbolDefinitionsInSourceText({ fileName: "a.ts", sourceText: "export type Thing = string", candidateNames: ["Thing"] })[0]?.symbolName // => "Thing"
 */
export const findSymbolDefinitionsInSourceText = (params: FindSymbolDefinitionsParams): SourceSymbolDefinition[] => {
  const candidateNameSet = new Set(params.candidateNames)
  const sourceFile = ts.createSourceFile(
    params.fileName,
    params.sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKindForFileName(params.fileName),
  )
  const definitions: SourceSymbolDefinition[] = []

  /**
   * Visits each AST node so exported and local declarations can both be link targets.
   * @param node - The current TypeScript AST node.
   * @returns Nothing; matching declarations are pushed into `definitions`.
   * @example
   * visit(sourceFile) // scans every declaration in a file
   */
  const visit = (node: ts.Node): void => {
    const declarationName = getDeclarationIdentifier(node)

    if (declarationName && candidateNameSet.has(declarationName.text)) {
      definitions.push(createSourceSymbolDefinition(sourceFile, declarationName))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return definitions
}

/**
 * Maps file extensions to TypeScript parser modes.
 * @param fileName - The source file name from VS Code.
 * @returns The script kind TypeScript should use for parsing.
 * @example
 * getScriptKindForFileName("component.tsx") // => ts.ScriptKind.TSX
 */
const getScriptKindForFileName = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (fileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  if (fileName.endsWith('.js')) {
    return ts.ScriptKind.JS
  }

  return ts.ScriptKind.TS
}

/**
 * Returns the identifier that defines a symbol for declaration nodes this extension can jump to.
 * @param node - A TypeScript AST node.
 * @returns
 * - The declaration identifier when the node names a symbol
 * - `undefined` for syntax nodes that are not navigable declarations
 * @example
 * getDeclarationIdentifier(variableDeclarationNode)?.text // => "useThing"
 */
const getDeclarationIdentifier = (node: ts.Node): ts.Identifier | undefined => {
  if (isNamedDeclarationWithIdentifier(node)) {
    return node.name
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name
  }

  return undefined
}

/**
 * Narrows TypeScript nodes that expose a declaration `name` field with an identifier.
 * @param node - A TypeScript AST node.
 * @returns `true` when the node has an identifier name that represents a declaration.
 * @example
 * isNamedDeclarationWithIdentifier(functionDeclarationNode) // => true
 */
const isNamedDeclarationWithIdentifier = (
  node: ts.Node,
): node is NamedIdentifierDeclaration => {
  if (
    !(
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isEnumMember(node)
    )
  ) {
    return false
  }

  return Boolean(node.name && ts.isIdentifier(node.name))
}

/**
 * Converts a TypeScript identifier into a VS Code-friendly source range.
 * @param sourceFile - The parsed TypeScript source file.
 * @param identifier - The declaration identifier that matched a link target.
 * @returns The symbol definition range in zero-based line and character coordinates.
 * @example
 * createSourceSymbolDefinition(sourceFile, identifier).symbolName // => "Thing"
 */
const createSourceSymbolDefinition = (
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier,
): SourceSymbolDefinition => {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(identifier.getStart(sourceFile))
  const endPosition = sourceFile.getLineAndCharacterOfPosition(identifier.getEnd())

  return {
    symbolName: identifier.text,
    startLine: startPosition.line,
    startCharacter: startPosition.character,
    endLine: endPosition.line,
    endCharacter: endPosition.character,
  }
}
