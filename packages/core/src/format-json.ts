/**
 * Human-readable JSON for the sidecar: 2-space indent like Prettier, but
 * anything that fits on one line stays on one line (`{ "kind": "face", "id": 7, "seq": 1 }`,
 * a run `[120, 3]`), and long number lists (samples) wrap at the line width instead of taking
 * one line per number — keeps the file readable without making it much bigger.
 */

/** Line width the formatter aims for (strings longer than this still stay on one line). */
export const JSON_LINE_WIDTH = 100;

export function formatJson(value: unknown, width = JSON_LINE_WIDTH): string {
  return `${block(value, '', width)}\n`;
}

/** One-line form with Prettier-like spacing; `undefined` members are left out like JSON.stringify. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => inline(x ?? null)).join(', ')}]`;
  if (isObject(v)) {
    const parts = members(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  return JSON.stringify(v ?? null);
}

function block(v: unknown, indent: string, width: number): string {
  const flat = inline(v);
  if (indent.length + flat.length <= width || (!Array.isArray(v) && !isObject(v))) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.every((x) => !Array.isArray(x) && !isObject(x))) {
      // Primitives (sample coordinates): as many per line as fit.
      const lines: string[] = [];
      let line = '';
      for (const x of v) {
        const item = `${inline(x ?? null)},`;
        if (line && inner.length + line.length + 1 + item.length > width) {
          lines.push(line);
          line = item;
        } else line = line ? `${line} ${item}` : item;
      }
      lines.push(line.slice(0, -1));
      return `[\n${lines.map((l) => inner + l).join('\n')}\n${indent}]`;
    }
    return `[\n${v.map((x) => inner + block(x ?? null, inner, width)).join(',\n')}\n${indent}]`;
  }
  const rows = members(v).map(
    ([k, x]) => `${inner}${JSON.stringify(k)}: ${block(x, inner, width)}`,
  );
  return `{\n${rows.join(',\n')}\n${indent}}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function members(o: Record<string, unknown>): [string, unknown][] {
  return Object.entries(o).filter(([, x]) => x !== undefined);
}
