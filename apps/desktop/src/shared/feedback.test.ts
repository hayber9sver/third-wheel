import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_FORM_SETUP_FIELD,
  FEEDBACK_FORM_URL,
  FEEDBACK_ISSUE_URL,
  MAX_SETUP_LENGTH,
  feedbackUrl,
  isFeedbackPlace,
  osLine,
  setupLine,
} from './feedback.js';

const mac = { platform: 'darwin', osVersion: '15.2.0', arch: 'arm64' };

describe('feedback', () => {
  it('osLine names macOS and Windows 10 / 11 by version', () => {
    expect(osLine(mac)).toBe('macOS 15.2 (arm64)');
    expect(osLine({ platform: 'darwin', osVersion: '14.6.1', arch: 'x64' })).toBe(
      'macOS 14.6.1 (x64)',
    );
    expect(osLine({ platform: 'win32', osVersion: '10.0.22631', arch: 'x64' })).toBe(
      'Windows 11 (10.0.22631, x64)',
    );
    expect(osLine({ platform: 'win32', osVersion: '10.0.19045', arch: 'x64' })).toBe(
      'Windows 10 (10.0.19045, x64)',
    );
    expect(osLine({ platform: 'linux', osVersion: '6.8', arch: 'x64' })).toBe('linux 6.8 (x64)');
  });

  it('setupLine: version · OS · agent (only when known)', () => {
    expect(setupLine('0.2.0', mac)).toBe('Third Wheel 0.2.0 · macOS 15.2 (arm64)');
    expect(setupLine('0.2.0', mac, 'Claude Code')).toBe(
      'Third Wheel 0.2.0 · macOS 15.2 (arm64) · Claude Code',
    );
  });

  it('GitHub link: new issue, "Feedback: " title, setup line under a rule', () => {
    const url = new URL(feedbackUrl('github', 'S'));
    expect(`${url.origin}${url.pathname}`).toBe(FEEDBACK_ISSUE_URL);
    expect(url.searchParams.get('title')).toBe('Feedback: ');
    expect(url.searchParams.get('body')).toBe('\n\n---\nS');
    expect(new URL(feedbackUrl('github')).searchParams.has('body')).toBe(false);
  });

  it('Form link: setup field pre-filled; left out without it', () => {
    const url = new URL(feedbackUrl('form', 'Third Wheel 0.2.0 · macOS 15.2'));
    expect(`${url.origin}${url.pathname}`).toBe(FEEDBACK_FORM_URL);
    expect(url.searchParams.get('usp')).toBe('pp_url');
    expect(url.searchParams.get(FEEDBACK_FORM_SETUP_FIELD)).toBe('Third Wheel 0.2.0 · macOS 15.2');
    expect([...new URL(feedbackUrl('form', ' ')).searchParams.keys()]).toEqual(['usp']);
  });

  it('a long setup line is cut', () => {
    const url = new URL(feedbackUrl('form', 'x'.repeat(1000)));
    expect(url.searchParams.get(FEEDBACK_FORM_SETUP_FIELD)).toHaveLength(MAX_SETUP_LENGTH);
  });

  it('isFeedbackPlace takes only the two places', () => {
    expect(isFeedbackPlace('github')).toBe(true);
    expect(isFeedbackPlace('form')).toBe(true);
    expect(isFeedbackPlace('https://example.com')).toBe(false);
  });
});
