// Third-party notices for the app (T13.1): every package Third Wheel ships at run time, with its
// licence text copied from the package itself.
//
//   node scripts/third-party-notices.js          writes apps/desktop/resources/THIRD_PARTY_NOTICES.txt
//   node scripts/third-party-notices.js --check  exits 1 when that file is out of date
//
// "Ships at run time" = the production dependencies (`dependencies`, installed
// `optionalDependencies`) of the workspace packages, followed through node_modules, plus Electron
// itself. The walk uses Node's lookup (node_modules folders up from the package's real folder), so it
// works with pnpm's layout without calling pnpm. A unit test (apps/desktop/src/main/
// third-party-notices.test.ts) runs `buildNotices` and compares it with the committed file.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_FILE = join('apps', 'desktop', 'resources', 'THIRD_PARTY_NOTICES.txt');

/** Workspace packages whose production dependencies end up in the app (the MCP server is shipped too). */
const WORKSPACE_ROOTS = [
  join('apps', 'desktop'),
  join('packages', 'core'),
  join('packages', 'geometry'),
  join('packages', 'mcp-server'),
];

/**
 * Shipped although it is a devDependency: the runtime itself. Only the package — its own
 * dependencies download the binary at install time and are not shipped.
 */
const EXTRA_LEAVES = [{ from: join('apps', 'desktop'), name: 'electron' }];

/**
 * Packages whose own licence file is missing or doesn't cover what we ship — written by hand from the
 * package's README (read, not guessed). Keyed by package name.
 */
const SPECIAL = {
  'occt-wasm': (pkg) =>
    [
      'occt-wasm ships no licence file. Its README ("License") says:',
      '  Build tooling (xtask, scripts, TypeScript wrapper): MIT OR Apache-2.0',
      '  Compiled WASM output: LGPL-2.1-only, inherited from',
      '  Open CASCADE Technology (OCCT), https://dev.opencascade.org/',
      '',
      'Third Wheel uses the compiled OpenCascade kernel unchanged, as a separate file',
      '(occt-wasm-<hash>.wasm next to the app) that can be replaced with your own build of the',
      'same version.',
      'Third Wheel patches the TypeScript wrapper (dist/index.js, MIT OR Apache-2.0) to read',
      'result pointers as unsigned numbers: patches/occt-wasm@5.15.0.patch in the Third Wheel',
      'source repository, https://github.com/XiLaoTr/third-wheel',
      '',
      `Source code: ${repoUrl(pkg) ?? 'https://github.com/andymai/occt-wasm'} (occt-wasm),`,
      'https://github.com/Open-Cascade-SAS/OCCT (OpenCascade).',
      '',
      'The full text of the GNU Lesser General Public License version 2.1 follows.',
      '',
      readText(join(REPO_ROOT, 'scripts', 'licences', 'LGPL-2.1.txt')),
    ].join('\n'),
};

/**
 * Python libraries the parts catalogue was generated with (scripts/library/generate_catalogue.py). Only the
 * generated data ships (the part list, standard sizes and low-polygon preview meshes of
 * apps/desktop/src/renderer/src/library/data), not their code. Versions are the pins in
 * scripts/library/requirements.txt; licence files are copied verbatim from the packages.
 */
const CATALOGUE_SOURCES = [
  {
    name: 'bd_warehouse',
    licence: 'Apache-2.0',
    url: 'https://github.com/gumyr/bd_warehouse',
    files: ['bd_warehouse-LICENSE.txt'],
  },
  {
    name: 'build123d',
    licence: 'Apache-2.0',
    url: 'https://github.com/gumyr/build123d',
    files: ['build123d-LICENSE.txt', 'build123d-NOTICE.txt'],
  },
];

/** Version of a Python package as pinned in scripts/library/requirements.txt. */
function pinnedVersion(name, root) {
  const text = readText(join(root, 'scripts', 'library', 'requirements.txt'));
  const match = new RegExp('^' + name + '==(\\S+)$', 'm').exec(text);
  if (!match) throw new Error(name + ' is not pinned in scripts/library/requirements.txt');
  return match[1];
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').trimEnd();
}

function repoUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return undefined;
  return repo
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^(git|ssh):\/\/(git@)?/, 'https://')
    .replace(/^https:\/\/git@/, 'https://')
    .replace(/^github:/, 'https://github.com/');
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type).join(' OR ');
  return 'UNKNOWN';
}

/** Folder of package `name` as Node would find it from `fromDir`, or undefined when not installed. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * All third-party packages shipped at run time, sorted by name then version.
 * @returns {{ name: string, version: string, license: string, dir: string, pkg: any }[]}
 */
export function collectPackages(root = REPO_ROOT) {
  const found = new Map();
  const queue = [];
  const leaves = new Set();
  const enqueue = (name, fromDir, required) => {
    const dir = resolvePackageDir(name, fromDir);
    if (!dir) {
      if (required)
        throw new Error(`${name} is not installed (needed by ${fromDir}): run pnpm install`);
      return undefined;
    }
    queue.push(dir);
    return dir;
  };
  for (const ws of WORKSPACE_ROOTS) {
    const dir = join(root, ws);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      if (!String(spec).startsWith('workspace:')) enqueue(name, dir, true);
    }
  }
  for (const extra of EXTRA_LEAVES) leaves.add(enqueue(extra.name, join(root, extra.from), true));

  while (queue.length > 0) {
    const dir = queue.pop();
    if (found.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    found.set(dir, { name: pkg.name, version: pkg.version, license: licenceOf(pkg), dir, pkg });
    if (leaves.has(dir)) continue;
    for (const name of Object.keys(pkg.dependencies ?? {})) enqueue(name, dir, true);
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) enqueue(name, dir, false);
  }
  // pnpm can keep one version twice (e.g. occt-wasm patched + unpatched copy): one entry per name@version.
  const unique = new Map();
  for (const p of found.values()) {
    const key = `${p.name}@${p.version}`;
    if (!unique.has(key)) unique.set(key, p);
  }
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  );
}

/** Licence as the notices show it (occt-wasm: the wrapper's and the kernel's). */
function shownLicence(p) {
  return p.name === 'occt-wasm'
    ? 'MIT OR Apache-2.0 (wrapper); LGPL-2.1-only (OpenCascade kernel)'
    : p.license;
}

function licenceText(p) {
  const special = SPECIAL[p.name];
  if (special) return special(p.pkg);
  const files = readdirSync(p.dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (files.length === 0) {
    return `No licence file in the package. Its package.json says: ${p.license}.`;
  }
  return files.map((f) => readText(join(p.dir, f))).join('\n\n');
}

/** The notices file's text (LF line endings, ends with a newline). */
export function buildNotices(root = REPO_ROOT) {
  const packages = collectPackages(root);
  const rule = '='.repeat(78);
  const out = [
    'Third Wheel — third-party notices',
    '',
    'Third Wheel (© 2026 XiLaoTr, Apache License 2.0) includes the open-source packages below.',
    'Each is listed with its version, its licence and the licence text it ships with.',
    'The parts library data (see the end) was generated with bd_warehouse and build123d.',
    'Electron also includes Chromium and its components; their licences are in',
    'LICENSES.chromium.html next to the app.',
    '',
    'This file is generated by scripts/third-party-notices.js; do not edit it by hand.',
    '',
    `Packages (${packages.length}):`,
    ...packages.map((p) => `  ${p.name} ${p.version} — ${shownLicence(p)}`),
  ];
  for (const p of packages) {
    out.push('', rule, `${p.name} ${p.version} — ${shownLicence(p)}`);
    const url = repoUrl(p.pkg);
    if (url) out.push(url);
    out.push(rule, '', licenceText(p));
  }
  // The parts library: data generated with these Python libraries (not their code).
  out.push(
    '',
    rule,
    'Parts library data: generated with bd_warehouse and build123d',
    rule,
    '',
    'The Library panel lists parts of bd_warehouse (standard fasteners, bearings, gears, ...) with',
    'low-polygon preview pictures. That list, the standard sizes and the preview meshes were generated',
    'with the libraries below and ship as data files (library/data in the source repository); the',
    'libraries themselves are not part of the app. Both are licensed under the Apache License,',
    'Version 2.0.',
  );
  for (const src of CATALOGUE_SOURCES) {
    out.push(
      '',
      rule,
      src.name + ' ' + pinnedVersion(src.name, root) + ' — ' + src.licence,
      src.url,
      rule,
      '',
    );
    out.push(src.files.map((f) => readText(join(root, 'scripts', 'licences', f))).join('\n\n'));
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = join(REPO_ROOT, NOTICES_FILE);
  const text = buildNotices();
  if (process.argv.includes('--check')) {
    const current = existsSync(target) ? readText(target) + '\n' : '';
    if (current !== text) {
      console.error(`${NOTICES_FILE} is out of date: run node scripts/third-party-notices.js`);
      process.exit(1);
    }
    console.log(`${NOTICES_FILE} is up to date.`);
  } else {
    writeFileSync(target, text);
    console.log(`Wrote ${NOTICES_FILE} (${collectPackages().length} packages).`);
  }
}
