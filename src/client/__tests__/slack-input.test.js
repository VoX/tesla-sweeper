import { describe, it, expect } from 'vitest';
import { parseSlackInput } from '../lib/slack-input.js';

describe('parseSlackInput', () => {
  it('returns the bare U-id unchanged', () => {
    expect(parseSlackInput('U060NLFUM')).toBe('U060NLFUM');
  });

  it('strips whitespace from raw input', () => {
    expect(parseSlackInput('  U060NLFUM  ')).toBe('U060NLFUM');
  });

  it('extracts U-id from /team/ URL', () => {
    expect(parseSlackInput('https://app.slack.com/team/U060NLFUM')).toBe('U060NLFUM');
  });

  it('extracts U-id from /user_profile/ URL', () => {
    expect(parseSlackInput('https://example.slack.com/user_profile/U060NLFUM')).toBe('U060NLFUM');
  });

  it('extracts U-id from query-string ?id=U... URL', () => {
    expect(parseSlackInput('slack://user?id=U060NLFUM')).toBe('U060NLFUM');
  });

  it('passes-through URLs whose path-shape isn\'t /team/ or /user_profile/ or ?id=', () => {
    // The fallback U-token regex requires a LETTER as the second char
    // (`U[A-Z]...`), so real-life U-ids like `U060NLFUM` (digit-second)
    // are intentionally only extracted from the documented URL shapes.
    const url = 'https://app.slack.com/client/T060NME06/U060NLFUM/foo';
    expect(parseSlackInput(url)).toBe(url);
  });

  it('passes-through input with no U-id and no URL shape', () => {
    expect(parseSlackInput('not a slack id')).toBe('not a slack id');
  });

  it('passes-through input with URL shape but no U-id', () => {
    expect(parseSlackInput('https://example.com/team/notauid')).toBe('https://example.com/team/notauid');
  });
});
