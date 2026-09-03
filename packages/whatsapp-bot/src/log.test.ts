import { describe, expect, it } from 'vitest';
import { redactJids, tag } from './log';

const GROUP = '120363000000000001@g.us';
const SENDER = '33612345678@s.whatsapp.net';

describe('logs carry tags, never numbers (#236)', () => {
  it('tags every JID inside a command id, keeping the rest of it readable', () => {
    const redacted = redactJids(`leader:${GROUP}:20700:${SENDER}:3`);
    expect(redacted).toBe(`leader:${tag(GROUP)}:20700:${tag(SENDER)}:3`);
    expect(redacted).not.toContain('33612345678');
    expect(redacted).not.toContain('@g.us');
  });

  it('covers the LID form and leaves a string with no JID alone', () => {
    expect(redactJids('react:123456789012345@lid:3EB0')).toBe(
      `react:${tag('123456789012345@lid')}:3EB0`,
    );
    expect(redactJids('podium: nothing personal here')).toBe('podium: nothing personal here');
  });

  it('tags the same JID to the same handle wherever it appears', () => {
    expect(redactJids(`${GROUP} ${GROUP}`)).toBe(`${tag(GROUP)} ${tag(GROUP)}`);
  });

  it('takes a device suffix with it, rather than leaving half a number behind', () => {
    const withDevice = '33612345678:12@s.whatsapp.net';
    expect(redactJids(withDevice)).toBe(tag(withDevice));
    expect(redactJids(withDevice)).not.toContain('33612345678');
  });

  it('does not read a command id\'s own colons as one long JID', () => {
    // `leader:<group>:<day>:<sender>:<score>` — the day survives as itself.
    expect(redactJids(`leader:${GROUP}:20700:${SENDER}:3`)).toContain(':20700:');
  });
});
