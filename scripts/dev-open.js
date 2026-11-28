// `pnpm dev:open <model.step>` — start the app in dev mode and open that model right away.
// Without a file it reopens the last one opened this way. Works on macOS and Windows
// (sets the THIRD_WHEEL_OPEN dev hook from apps/desktop/src/main/wiring/app-lifecycle.ts).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lastFile = join(root, 'node_modules', '.cache', 'third-wheel', 'last-open.txt');

// pnpm runs scripts from the repo root; INIT_CWD is where the user typed the command.
const arg = process.argv[2];
let model = arg ? resolve(process.env['INIT_CWD'] ?? process.cwd(), arg) : undefined;
if (!model && existsSync(lastFile)) model = readFileSync(lastFile, 'utf8').trim();
if (!model) {
  console.error('Usage: pnpm dev:open <model.step>   (later just: pnpm dev:open)');
  process.exit(1);
}
if (!existsSync(model)) {
  console.error(`File not found: ${model}`);
  process.exit(1);
}
mkdirSync(dirname(lastFile), { recursive: true });
writeFileSync(lastFile, model);
console.log(`Opening ${model}`);

const env = { ...process.env, THIRD_WHEEL_OPEN: model };
// Terminals inside VS Code may set this, which makes Electron start as plain Node.
delete env['ELECTRON_RUN_AS_NODE'];
const child = spawn('pnpm', ['dev'], { cwd: root, env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
