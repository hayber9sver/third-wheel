/**
 * Body tree for the left panel: STEP assemblies become folders, bodies are the leaves.
 * Pure data — no DOM — so it can be unit tested.
 */

export interface BodyLeaf {
  readonly kind: 'body';
  readonly body: number;
}

export interface Folder {
  readonly kind: 'folder';
  /** Row key: "f<assembly>" for a STEP assembly, "u<id>" for a user folder. */
  readonly key: string;
  /** Index into the model's `assemblies`; -1 for a user folder. */
  readonly assembly: number;
  /** Id of a user folder; undefined for a STEP assembly. */
  readonly userId?: string;
  readonly name: string;
  readonly children: readonly TreeNode[];
  /** Every body inside this folder (any depth), ascending. */
  readonly bodies: readonly number[];
}

export type TreeNode = BodyLeaf | Folder;

export interface AssemblyRef {
  readonly name: string;
  readonly parent: number;
}

interface MutableFolder {
  kind: 'folder';
  key: string;
  assembly: number;
  name: string;
  children: TreeNode[];
  bodies: number[];
}

const firstBody = (n: TreeNode): number => (n.kind === 'body' ? n.body : (n.bodies[0] ?? 0));

/**
 * Build the tree. `bodyAssembly[b]` = innermost assembly of body b (-1 = top level).
 * Children keep STEP order (bodies are numbered depth-first, so sorting by first body id restores
 * it). Folders without bodies are dropped. While the top level is a single folder (plus at most the
 * `looseBody`), that wrapper is unwrapped — most files put everything in one assembly named after
 * the file.
 */
export function buildBodyTree(
  bodyCount: number,
  assemblies: readonly AssemblyRef[],
  bodyAssembly: ArrayLike<number>,
  looseBody = -1,
): TreeNode[] {
  const folders: MutableFolder[] = assemblies.map((a, i) => ({
    kind: 'folder',
    key: `f${String(i)}`,
    assembly: i,
    name: a.name,
    children: [],
    bodies: [],
  }));
  const top: TreeNode[] = [];
  const valid = (a: number): boolean => a >= 0 && a < folders.length;

  for (let b = 0; b < bodyCount; b++) {
    const leaf: BodyLeaf = { kind: 'body', body: b };
    const own = bodyAssembly[b] ?? -1;
    if (!valid(own) || b === looseBody) {
      top.push(leaf);
      continue;
    }
    (folders[own] as MutableFolder).children.push(leaf);
    // Record the body in every enclosing folder (guard against a malformed parent cycle).
    for (let a = own, steps = 0; valid(a) && steps <= folders.length; steps++) {
      const f = folders[a] as MutableFolder;
      f.bodies.push(b);
      a = assemblies[a]?.parent ?? -1;
    }
  }
  // Attach non-empty folders to their parents (children have higher indices than parents; a
  // malformed parent link just puts the folder at the top level).
  folders.forEach((f, i) => {
    if (f.bodies.length === 0) return;
    const parent = assemblies[i]?.parent ?? -1;
    if (valid(parent) && parent < i) (folders[parent] as MutableFolder).children.push(f);
    else top.push(f);
  });
  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((x, y) => firstBody(x) - firstBody(y));
    for (const n of nodes) if (n.kind === 'folder') sort(n.children as TreeNode[]);
  };
  sort(top);

  let roots = top;
  for (;;) {
    const onlyFolders = roots.filter((n): n is Folder => n.kind === 'folder');
    const others = roots.filter((n): n is BodyLeaf => n.kind === 'body');
    const wrapper = onlyFolders[0];
    if (onlyFolders.length !== 1 || !wrapper) break;
    if (!others.every((n) => n.body === looseBody)) break;
    roots = [...wrapper.children, ...others];
  }
  return roots;
}

export type FolderVisibility = 'shown' | 'hidden' | 'mixed';

/** Whether all, none or some of `bodies` are visible. */
export function folderVisibility(
  bodies: readonly number[],
  visible: readonly boolean[],
): FolderVisibility {
  let shown = 0;
  for (const b of bodies) if (visible[b] ?? true) shown++;
  if (shown === bodies.length) return 'shown';
  return shown === 0 ? 'hidden' : 'mixed';
}

/** Folders that start open: the top level only. */
export function initiallyOpen(roots: readonly TreeNode[]): Set<string> {
  return new Set(roots.flatMap((n) => (n.kind === 'folder' ? [n.key] : [])));
}

export interface TreeRow {
  readonly node: TreeNode;
  readonly depth: number;
}

/** The rows to draw: depth-first, skipping the inside of closed folders. */
export function visibleRows(roots: readonly TreeNode[], open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === 'folder' && open.has(node.key)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/** Stable key of a row: "b<id>" for a body, "f<assembly>" / "u<id>" for a folder. */
export function rowKey(node: TreeNode): string {
  return node.kind === 'body' ? `b${String(node.body)}` : node.key;
}

/** Bodies a row stands for: the body itself, or everything inside the folder. */
export function rowBodies(node: TreeNode): readonly number[] {
  return node.kind === 'body' ? [node.body] : node.bodies;
}

/**
 * Shift-click range in the list (like Windows Explorer): every body of the
 * shown rows from the `anchor` row to the clicked row, either direction, each body once. Without
 * a shown anchor (none yet, or inside a folder closed since) only the clicked row counts.
 */
export function rangeBodies(
  rows: readonly TreeRow[],
  anchor: string | undefined,
  clicked: string,
): number[] {
  const to = rows.findIndex((r) => rowKey(r.node) === clicked);
  if (to < 0) return [];
  let from = anchor === undefined ? -1 : rows.findIndex((r) => rowKey(r.node) === anchor);
  if (from < 0) from = to;
  const seen = new Set<number>();
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const row = rows[i];
    if (row) for (const b of rowBodies(row.node)) seen.add(b);
  }
  return [...seen];
}
