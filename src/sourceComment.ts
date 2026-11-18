import * as ts from 'typescript'
import type { TextDocument } from 'vscode'

type SourceDocument = Pick<TextDocument, 'fileName' | 'version' | 'getText'>

const parsedDocuments = new WeakMap<SourceDocument, { version: number; sourceFile: ts.SourceFile }>()

/**
 * Checks whether a potential hover target belongs to a JavaScript or TypeScript comment.
 * The hover provider calls this after matching a link so other positions skip parsing.
 * @example
 * isSourceCommentAtOffset(document, document.offsetAt(position))
 */
export function isSourceCommentAtOffset(document: SourceDocument, offset: number): boolean {
  let parsed = parsedDocuments.get(document)

  // Reparse after edits. The weak key lets closed documents be collected.
  if (parsed?.version !== document.version) {
    parsed = {
      version: document.version,
      sourceFile: ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.Latest),
    }
    parsedDocuments.set(document, parsed)
  }

  const { sourceFile } = parsed
  let node: ts.Node = sourceFile

  // Descend to the token that owns this offset, including its leading trivia.
  while (!ts.isJSDoc(node)) {
    const child = node.getChildren(sourceFile).find(
      (candidate) => candidate.getFullStart() <= offset && offset < candidate.getEnd(),
    )
    if (!child) {
      break
    }
    node = child
  }

  if (ts.isJSDoc(node)) {
    return true
  }

  // Text inside a token can look like a comment, especially in template literals and JSX.
  if (ts.isJsxText(node) || offset >= node.getStart(sourceFile)) {
    return false
  }

  // A token owns the trailing comments of the previous token as well as its own leading comments.
  const fullStart = node.getFullStart()
  return [
    ts.getLeadingCommentRanges(sourceFile.text, fullStart),
    ts.getTrailingCommentRanges(sourceFile.text, fullStart),
  ]
    .some((ranges) => ranges?.some((range) => range.pos <= offset && offset < range.end))
}
