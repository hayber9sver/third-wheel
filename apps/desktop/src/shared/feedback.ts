/**
 * Help ▸ Send feedback…: the setup line (app version, OS, agent) and the two places feedback can go —
 * a new public GitHub issue or the private feedback form (Google Forms), each with the setup line
 * filled in (the form through its `entry.<id>` field). The user writes the feedback there. Main builds
 * the link from these fixed addresses only; nothing is sent by the app itself.
 */
import { APP_DISPLAY_NAME } from './app-name.js';
import { APP_REPO_URL } from './about.js';

export type FeedbackPlace = 'github' | 'form';

export function isFeedbackPlace(x: unknown): x is FeedbackPlace {
  return x === 'github' || x === 'form';
}

/** New issue in the public repository. */
export const FEEDBACK_ISSUE_URL = `${APP_REPO_URL}/issues/new`;
/** The private feedback form (Google Forms). */
export const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeiXqTlHbmGAjzkuRf5D0r5nzwWVI_52t_7xEh9jIVa3Anfgg/viewform';
/** The form's field the app fills: "Your version number, operation system and AI agent". */
export const FEEDBACK_FORM_SETUP_FIELD = 'entry.259798060';
/** The longest setup line main takes from the page. */
export const MAX_SETUP_LENGTH = 300;

export interface SystemInfo {
  /** `process.platform`: "darwin", "win32", … */
  readonly platform: string;
  /** `process.getSystemVersion()`: "15.2.0" on macOS, "10.0.22631" on Windows. */
  readonly osVersion: string;
  readonly arch: string;
}

/** "macOS 15.2 (arm64)", "Windows 11 (10.0.22631, x64)". */
export function osLine(info: SystemInfo): string {
  const v = info.osVersion.trim();
  if (info.platform === 'darwin') return `macOS ${v.replace(/\.0$/, '')} (${info.arch})`;
  if (info.platform === 'win32') {
    // Windows 11 still reports 10.0; its builds start at 22000.
    const build = Number(v.split('.')[2] ?? '');
    const name = v.startsWith('10.') && build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${v.startsWith('10.') ? name : 'Windows'} (${v}, ${info.arch})`;
  }
  return `${info.platform} ${v} (${info.arch})`;
}

/** "Third Wheel 0.2.0 · macOS 15.2 (arm64) · Claude Code"; the agent only when one connected. */
export function setupLine(appVersion: string, info: SystemInfo, agent?: string): string {
  return [`${APP_DISPLAY_NAME} ${appVersion}`, osLine(info), ...(agent ? [agent] : [])].join(' · ');
}

/**
 * The link for one place, with the setup line filled in when given. The GitHub issue starts with
 * "Feedback: " as its title and the setup line under a rule, so the user writes above it.
 */
export function feedbackUrl(place: FeedbackPlace, setup?: string): string {
  const params = new URLSearchParams();
  const line = setup?.trim().slice(0, MAX_SETUP_LENGTH);
  if (place === 'github') {
    params.set('title', 'Feedback: ');
    if (line) params.set('body', `\n\n---\n${line}`);
    return `${FEEDBACK_ISSUE_URL}?${params.toString()}`;
  }
  params.set('usp', 'pp_url');
  if (line) params.set(FEEDBACK_FORM_SETUP_FIELD, line);
  return `${FEEDBACK_FORM_URL}?${params.toString()}`;
}
