/**
 * The agent description files in `apps/desktop/agents/`, built into the app (main and renderer
 * each get a copy). Adding a file there adds a tab; no code to change.
 */
/// <reference types="vite/client" />
import { readAgentDescs, type AgentDesc } from './agent-desc.js';

const files = import.meta.glob<unknown>('../../agents/*.json', { eager: true, import: 'default' });

const read = readAgentDescs(files);

/** Every checked description, in tab order (tested or not). */
export const ALL_AGENTS: readonly AgentDesc[] = read.agents;

/** Problems in description files (those files are left out); CI fails on any. */
export const AGENT_PROBLEMS: readonly string[] = read.problems;

/** The description with this id, or undefined. */
export function agentById(id: unknown): AgentDesc | undefined {
  return ALL_AGENTS.find((a) => a.id === id);
}

/**
 * The tabs the pop-up shows: only agents someone tried with the real program, unless
 * `showUntested` (dev / e2e: THIRD_WHEEL_SHOW_UNTESTED=1).
 */
export function visibleAgents(showUntested: boolean): readonly AgentDesc[] {
  return ALL_AGENTS.filter((a) => showUntested || a.tested !== null);
}
