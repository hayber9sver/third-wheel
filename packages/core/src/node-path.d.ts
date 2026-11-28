/**
 * Node's `path` for tests only (they check Windows paths with `path.win32` on any OS). Core code
 * itself never imports Node: eslint refuses `node:*` outside `*.test.ts`.
 */
declare module 'node:path' {
  interface NodePath {
    readonly sep: string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    isAbsolute(p: string): boolean;
    parse(p: string): { root: string };
  }
  const path: NodePath & { readonly win32: NodePath; readonly posix: NodePath };
  export default path;
}
