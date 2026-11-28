/**
 * Cleaning text that comes from files before it reaches the AI agent: part names in a STEP file,
 * file names, comments in a notes file someone else wrote. Such text can carry instructions
 * hidden from the user — invisible characters (zero-width, bidi overrides, Unicode "tag"
 * characters that spell out ASCII nobody sees) or a very long name with a second line. The MCP
 * server passes every reply through `cleanForAgent`; its tool texts tell the agent that names and
 * comments are user data, not instructions.
 */

import { MAX_COMMENT_LENGTH } from './schema.js';

/** Longest part / body / marker / project name the agent gets. */
export const AGENT_NAME_MAX = 200;
/** Longest file name the agent gets (the longest a file name can be on disk). */
export const AGENT_FILE_NAME_MAX = 255;
/** Longest path the agent gets. */
export const AGENT_PATH_MAX = 4096;
/** Longest other text (comment, reply, note) the agent gets: what the app lets anyone type, so no valid comment is cut. */
export const AGENT_TEXT_MAX = MAX_COMMENT_LENGTH;

/**
 * Characters nobody sees but a model reads: control characters (except tab and line break),
 * format characters (zero-width space / joiners, bidi marks and overrides, soft hyphen, BOM,
 * Unicode tags U+E0000–E007F), private-use characters, lone surrogates, variation selectors and
 * the Hangul fillers that draw as blanks.
 */
const HIDDEN =
  // eslint-disable-next-line no-control-regex -- finding control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Co}\p{Cs}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0]/gu;
/** Line and paragraph separators (U+2028 / U+2029) and carriage returns become plain line breaks. */
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

/** `text` without hidden characters; line breaks and tabs stay. */
export function stripHidden(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(HIDDEN, '');
}

/** At most `max` characters (whole code points); a cut text says how much was left out. */
export function capText(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}… [${String(points.length - max)} more characters cut]`;
}

/** A name for the agent: hidden characters gone, one line, spaces collapsed, at most `max`. */
export function cleanName(text: string, max = AGENT_NAME_MAX): string {
  return capText(stripHidden(text).replace(/\s+/g, ' ').trim(), max);
}

/** A file name for the agent: hidden characters gone, line breaks / tabs as spaces, nothing else changed. */
export function cleanFileName(text: string, max = AGENT_FILE_NAME_MAX): string {
  return capText(stripHidden(text).replace(/[\n\t]/g, ' '), max);
}

/** Free text for the agent (comment, reply): hidden characters gone, at most `max`. */
export function cleanText(text: string, max = AGENT_TEXT_MAX): string {
  return capText(stripHidden(text), max);
}

/** Keys whose strings are names (one line, `AGENT_NAME_MAX`); values of `bodies` count too. */
const NAME_KEYS = new Set(['name', 'title', 'project', 'bodies']);
/**
 * Keys whose strings are file names: one line, `AGENT_FILE_NAME_MAX`, spaces kept as they are (the
 * agent may look the file up by this name).
 */
const FILE_KEYS = new Set(['model', 'file', 'linkedModels', 'newVersions', 'modelSwitches']);
/** Keys whose strings are paths: hidden characters go, nothing else changes (they must still work). */
const PATH_KEYS = new Set(['path', 'folder', 'saveNextAs', 'of']);
/** Keys left alone: image data. */
const SKIP_KEYS = new Set(['png']);

export interface CleanOptions {
  /** Keys whose free text is not shortened (hidden characters still go): the user's own chat messages. */
  readonly uncapped?: ReadonlySet<string>;
}

/**
 * A copy of a bridge result with every string cleaned for the agent, by the key it sits under:
 * names and file names one line and short, paths only stripped, other text stripped and capped.
 * Numbers, booleans and object keys stay as they are.
 */
export function cleanForAgent<T>(value: T, options: CleanOptions = {}): T {
  return walk(value, undefined, options) as T;
}

/**
 * A bridge result for the agent: objects via `cleanForAgent`; a string holding JSON (the review
 * payload comes as text) is parsed, cleaned the same way and written back compact; any other
 * string only loses hidden characters (it is the app's own text, e.g. a status line).
 */
export function cleanResultForAgent(result: unknown, options: CleanOptions = {}): unknown {
  if (typeof result !== 'string') return cleanForAgent(result, options);
  const start = result.trimStart()[0];
  if (start === '{' || start === '[') {
    try {
      return JSON.stringify(cleanForAgent(JSON.parse(result) as unknown, options));
    } catch {
      // Not JSON after all: fall through.
    }
  }
  return stripHidden(result);
}

function walk(value: unknown, key: string | undefined, options: CleanOptions): unknown {
  if (typeof value === 'string') return cleanString(value, key, options);
  if (Array.isArray(value)) return value.map((v) => walk(v, key, options));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Members of `bodies` (index → name) are names; elsewhere a value takes its own key.
      out[k] = SKIP_KEYS.has(k) ? v : walk(v, key === 'bodies' ? 'bodies' : k, options);
    }
    return out;
  }
  return value;
}

function cleanString(text: string, key: string | undefined, options: CleanOptions): string {
  if (key !== undefined) {
    if (NAME_KEYS.has(key)) return cleanName(text, AGENT_NAME_MAX);
    if (FILE_KEYS.has(key)) return cleanFileName(text);
    if (PATH_KEYS.has(key)) return capText(stripHidden(text), AGENT_PATH_MAX);
    if (options.uncapped?.has(key)) return stripHidden(text);
  }
  return cleanText(text);
}
