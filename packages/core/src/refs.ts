import { createHash } from 'node:crypto'
import type { Node } from 'web-tree-sitter'

// References and fingerprints (D7).

// The SHA-256 of a node's tokens, comments and whitespace left out: reformatting or commenting
// the code does not change it, editing a token does.
export function fingerprint(node: Node, isComment: (node: Node) => boolean): string {
  const hash = createHash('sha256')
  const stack: Node[] = [node]
  while (stack.length > 0) {
    const current = stack.pop() as Node
    if (isComment(current)) continue
    if (current.childCount === 0) {
      hash.update(current.text)
      hash.update('\0')
      continue
    }
    for (let i = current.childCount - 1; i >= 0; i--) {
      const child = current.child(i)
      if (child) stack.push(child)
    }
  }
  return hash.digest('hex')
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export const declRef = (file: string, name: string) => `${file}#${name}`
export const fileRef = (file: string) => file
export const externalRef = (importPath: string, symbol?: string) =>
  symbol ? `ext:${importPath}#${symbol}` : `ext:${importPath}`

// Gives each name of a file its reference: the first `init` is `#init`, the second `#init~2`.
export class Names {
  private readonly seen = new Map<string, number>()

  take(name: string): string {
    const count = (this.seen.get(name) ?? 0) + 1
    this.seen.set(name, count)
    return count === 1 ? name : `${name}~${count}`
  }
}
