import { parse } from "acorn";

/** Top-level bindings are mutable, redeclarable globals, including let/const.
 * Function bodies and block-local declarations retain normal JavaScript semantics.
 */
export function compileRepl(source: string): string {
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
  const patches: Array<{ start: number; end: number; text: string }> = [];
  const names = new Set<string>();
  const hoisted: string[] = [];
  function bindings(node: any): void {
    if (node.type === "Identifier") names.add(node.name);
    else if (node.type === "RestElement") bindings(node.argument);
    else if (node.type === "AssignmentPattern") bindings(node.left);
    else if (node.type === "ArrayPattern") node.elements.filter(Boolean).forEach(bindings);
    else if (node.type === "ObjectPattern") node.properties.forEach((p: any) => bindings(p.type === "RestElement" ? p.argument : p.value));
  }
  for (const node of tree.body as any[]) {
    if (node.type === "VariableDeclaration") {
      const assignments = node.declarations.map((d: any) => {
        bindings(d.id);
        return d.init ? `(${source.slice(d.id.start, d.id.end)} = ${source.slice(d.init.start, d.init.end)})` : "void 0";
      });
      patches.push({ start: node.start, end: node.end, text: assignments.join(";\n") + ";" });
    } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      names.add(node.id.name);
      const assignment = `globalThis[${JSON.stringify(node.id.name)}] = (${source.slice(node.start, node.end)});`;
      if (node.type === "FunctionDeclaration") hoisted.push(assignment);
      patches.push({ start: node.start, end: node.end, text: node.type === "FunctionDeclaration" ? ";" : assignment });
    }
  }
  const last = tree.body.at(-1);
  if (last?.type === "ExpressionStatement") patches.push({ start: last.start, end: last.end, text: `return (${source.slice(last.expression.start, last.expression.end)});` });
  for (const patch of patches.sort((a, b) => b.start - a.start)) source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  const declarations = [...names].map(name => `if (!Object.hasOwn(globalThis, ${JSON.stringify(name)})) Object.defineProperty(globalThis, ${JSON.stringify(name)}, {value: undefined, writable: true, configurable: true});`).join("\n");
  return `${declarations}\n${hoisted.join("\n")}\n${source}\n`;
}
