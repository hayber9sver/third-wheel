/**
 * Electron main process: one window hosting the renderer.
 *
 * The parts live in `wiring/`, one module per area, and start in the order listed here. They
 * import each other's names from this file (never from a sibling module directly), so a cycle
 * between two parts can't change that order: a module's start-up code may use names of modules
 * above it; names of modules below it only inside functions that run later.
 */

export * from './wiring/window.js';
export * from './wiring/model-files.js';
export * from './wiring/open-folder.js';
export * from './wiring/project-ipc.js';
export * from './wiring/app-bridge.js';
export * from './wiring/agent-setup.js';
export * from './wiring/app-lifecycle.js';
