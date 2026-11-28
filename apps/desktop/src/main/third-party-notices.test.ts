// T13.1: the shipped third-party notices must list every runtime dependency, with its licence text,
// and must match what `scripts/third-party-notices.js` builds from node_modules today (so adding or
// updating a package without regenerating the file fails here).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface NoticesScript {
  readonly buildNotices: (root?: string) => string;
  readonly NOTICES_FILE: string;
}

async function loadScript(): Promise<NoticesScript> {
  const url = pathToFileURL(join(repoRoot, 'scripts', 'third-party-notices.js')).href;
  return (await import(url)) as NoticesScript;
}

function runtimeDeps(): string[] {
  const names = new Set<string>(['electron']);
  for (const ws of ['apps/desktop', 'packages/core', 'packages/geometry', 'packages/mcp-server']) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, ws, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (!spec.startsWith('workspace:')) names.add(name);
    }
  }
  return [...names];
}

describe('third-party notices', () => {
  it('is up to date with node_modules (run `pnpm notices` after changing dependencies)', async () => {
    const { buildNotices, NOTICES_FILE } = await loadScript();
    const committed = readFileSync(join(repoRoot, NOTICES_FILE), 'utf8').replace(/\r\n/g, '\n');
    expect(
      committed === buildNotices(repoRoot),
      `${NOTICES_FILE} is out of date: run pnpm notices`,
    ).toBe(true);
  });

  it("lists every workspace package's runtime dependency with a licence text", async () => {
    const { NOTICES_FILE } = await loadScript();
    const text = readFileSync(join(repoRoot, NOTICES_FILE), 'utf8');
    for (const name of runtimeDeps()) {
      const heading = new RegExp(
        `^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\S+ — .+$`,
        'm',
      );
      expect(text, name).toMatch(heading);
    }
    // The ones the task names, with the licences read from each package.
    expect(text).toMatch(/^three \S+ — MIT$/m);
    expect(text).toMatch(/^three-mesh-bvh \S+ — MIT$/m);
    expect(text).toMatch(/^@modelcontextprotocol\/sdk \S+ — MIT$/m);
    expect(text).toMatch(/LGPL-2\.1-only \(OpenCascade kernel\)/);
    // LGPL needs its full text, not only its name.
    expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(text).toContain('END OF TERMS AND CONDITIONS');
    expect(text).not.toContain('No licence file in the package');
  });

  it('credits the libraries the parts catalogue was generated with, at the pinned versions', async () => {
    const { NOTICES_FILE } = await loadScript();
    const text = readFileSync(join(repoRoot, NOTICES_FILE), 'utf8');
    const pins = readFileSync(join(repoRoot, 'scripts', 'library', 'requirements.txt'), 'utf8');
    for (const name of ['bd_warehouse', 'build123d']) {
      const version = new RegExp(`^${name}==([^\\s]+)$`, 'm').exec(pins)?.[1];
      expect(version, `${name} is pinned`).toBeDefined();
      expect(text).toContain(`${name} ${version ?? ''} — Apache-2.0`);
    }
    expect(text).toContain('Parts library data: generated with bd_warehouse and build123d');
    // build123d ships a NOTICE file that must be kept with the licence.
    expect(text).toContain('Copyright (c) 2022–2025 The build123d Contributors');
    expect(text).toContain('CadQuery');
  });
});
