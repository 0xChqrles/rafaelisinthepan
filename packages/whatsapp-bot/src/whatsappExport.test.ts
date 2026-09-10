import { describe, expect, it } from 'vitest';
import { parseGroupConfig } from './config/groupConfig';
import { instantIn, jidOfAuthor, messageInstant, parseExport, speakerName } from './whatsappExport';

const group = parseGroupConfig('g.json', {
  id: '120363000000000001@g.us',
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris',
  podium: { enabled: true, time: '22:30' },
  chat: { enabled: true },
  names: { '33680734588@s.whatsapp.net': 'Bruno Leduc' },
});
const names = { group, me: 'Charles', bot: 'WhippinBot' };

describe('reading a WhatsApp export (#277)', () => {
  it('reads days, times, authors, quotes and bodies that run over several lines', () => {
    const messages = parseExport(`# Exportation
Date d’exportation: September 10, 2026

---

## September 5, 2026

[12:04 AM] **Quentin Abel Marceau:** Pas ouf

[12:05 AM] **+33 6 59 01 82 62:**
> _Quentin Abel Marceau: T’en penses quoi ?_
La journée était rude.

[3:56 PM] __+33 6 60 03 14 50 a ajouté +33 6 72 64 66 94__

[7:40 PM] **Luc Le Père:** deux
lignes

---

## September 6, 2026

[7:01 AM] **Luc Le Père:** demain
`);
    expect(messages).toEqual([
      { day: 'September 5, 2026', time: '12:04 AM', author: 'Quentin Abel Marceau', quoted: null, text: 'Pas ouf' },
      { day: 'September 5, 2026', time: '12:05 AM', author: '+33 6 59 01 82 62', quoted: { author: 'Quentin Abel Marceau', text: 'T’en penses quoi ?' }, text: 'La journée était rude.' },
      { day: 'September 5, 2026', time: '7:40 PM', author: 'Luc Le Père', quoted: null, text: 'deux\nlignes' },
      { day: 'September 6, 2026', time: '7:01 AM', author: 'Luc Le Père', quoted: null, text: 'demain' },
    ]);
  });

  it('NEVER lets a phone number stand as a name: the override, or the …last4 handle', () => {
    // Half the authors of a real export are contacts the exporter has no name for.
    expect(jidOfAuthor('+33 6 80 73 45 88')).toBe('33680734588@s.whatsapp.net');
    expect(jidOfAuthor('Luc Le Père')).toBeNull();
    expect(jidOfAuthor('+1')).toBeNull();
    expect(speakerName('+33 6 80 73 45 88', names)).toBe('Bruno Leduc'); // the group's override
    expect(speakerName('+33 6 71 68 22 65', names)).toBe('…2265'); // nobody's override
    expect(speakerName('Luc Le Père', names)).toBe('Luc Le Père');
    expect(speakerName('~Whippin Bot', names)).toBe('Whippin Bot');
    expect(speakerName('Vous', names)).toBe('Charles');
    expect(speakerName(`${'Z'.repeat(60)}`, names)).toHaveLength(40); // the same bound a push name wears
  });

  it('reads a wall-clock time as an instant in the GROUP\'s zone, either side of a DST change', () => {
    // Paris is +02:00 in September and +01:00 in November; the same wall clock is a
    // different instant, and a seeded turn must print back as the time it was sent.
    expect(messageInstant('September 5, 2026', '10:31 PM', 'Europe/Paris')).toBe(Date.parse('2026-09-05T20:31:00Z'));
    expect(messageInstant('November 5, 2026', '10:31 PM', 'Europe/Paris')).toBe(Date.parse('2026-11-05T21:31:00Z'));
    expect(messageInstant('September 5, 2026', '12:04 AM', 'Europe/Paris')).toBe(Date.parse('2026-09-04T22:04:00Z'));
    expect(messageInstant('September 5, 2026', '12:04 PM', 'Europe/Paris')).toBe(Date.parse('2026-09-05T10:04:00Z'));
    // And it round-trips through the clock the prompt prints it with.
    const at = messageInstant('September 5, 2026', '7:40 PM', 'Europe/Paris')!;
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at))).toBe('19:40');
    expect(instantIn('UTC', 2026, 9, 5, 19, 40)).toBe(Date.parse('2026-09-05T19:40:00Z'));
    expect(messageInstant('Septembre 5, 2026', '7:40 PM', 'Europe/Paris')).toBeNull();
    expect(messageInstant('September 5, 2026', 'ce soir', 'Europe/Paris')).toBeNull();
  });
});
