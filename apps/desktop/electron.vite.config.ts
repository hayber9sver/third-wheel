import { defineConfig } from 'electron-vite';

// `pnpm dev` started from Claude Code inside VS Code inherits ELECTRON_RUN_AS_NODE=1, which makes
// Electron start as plain Node ("electron does not provide an export named BrowserWindow").
// electron-vite starts Electron with this process's environment, so clear it here.
delete process.env['ELECTRON_RUN_AS_NODE'];

export default defineConfig({
  main: {
    build: {
      // Workspace packages ship TypeScript source: bundle them. `ws` is bundled too, so the
      // installers need no node_modules at all; its optional native speed-ups stay out.
      externalizeDeps: { exclude: ['@third-wheel/core', 'ws'] },
      rolldownOptions: { external: ['bufferutil', 'utf-8-validate'] },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot be ES modules; emit a single CommonJS file.
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    // occt-wasm is imported only in the STEP worker, which Vite's start-up scan doesn't follow:
    // with an empty cache the first STEP open found it late and reloaded the window.
    optimizeDeps: { include: ['occt-wasm'] },
  },
});
