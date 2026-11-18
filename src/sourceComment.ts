import * as ts from 'typescript'

/**
 * Checks whether a potential hover target belongs to a JavaScript or TypeScript comment.
 * The hover provider calls this after matching a link so other positions skip parsing.
 * @example
 * isSourceCommentAtOffset('notes.ts', '// See {@link Thing}', 14) // => true
 */
export function isSourceCommentAtOffset(fileName: string, sourceText: string, offset: number): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest)
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
  return [ts.getLeadingCommentRanges(sourceText, fullStart), ts.getTrailingCommentRanges(sourceText, fullStart)]
    .some((ranges) => ranges?.some((range) => range.pos <= offset && offset < range.end))
}
