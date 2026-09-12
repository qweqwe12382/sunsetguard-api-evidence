import ts from "typescript";

/** Duplicate keys erase earlier configuration context in JSON.parse; keep that uncertainty visible. */
export function hasDuplicateJsonKeys(path: string, text: string): boolean {
  const source = ts.parseJsonText(path, text);
  const pending: ts.Node[] = [source];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) continue;
        if (names.has(name.text)) return true;
        names.add(name.text);
      }
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return false;
}
