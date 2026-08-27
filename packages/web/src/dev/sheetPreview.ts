import type { UiKey } from '../i18n';

// Development-only preview of the app's ONE error surface (`components/ErrorScreen`), so its
// design can be looked at and argued about without having to break a real request first.
// The `?streak=N` harness's rules, for its reasons: parsing is pure and injectable so a test
// can prove a PRODUCTION build ignores the parameter even when it is otherwise valid.
//
// Every variant here is a REAL call site's (title, note, retry) triple — never invented copy.
// That is the whole point of previewing on this surface rather than on a mock: what the box
// has to survive is the copy it actually carries, and the two shapes that copy comes in (the
// refusals that offer no retry explain themselves, and are the short ones).
export interface SheetVariant {
  title: UiKey;
  note: UiKey;
  // Absent where asking again cannot help — the moderation refusals.
  retry?: true;
}

export const SHEET_VARIANTS = {
  // The one production reported on 2026-08-27, and the longest note that carries a retry.
  account: { title: 'failedAccount', note: 'failedAccountNote', retry: true },
  share: { title: 'failedShare', note: 'failedShareNote', retry: true },
  start: { title: 'failedStart', note: 'failedStartNote', retry: true },
  invite: { title: 'failedInvite', note: 'failedInviteNote', retry: true },
  save: { title: 'profileSaveFailed', note: 'failedSaveNote', retry: true },
  name: { title: 'profileNameRejected', note: 'profileNameRejectedNote' },
  avatar: { title: 'profileAvatarRejected', note: 'profileAvatarRejectedNote' },
} as const satisfies Record<string, SheetVariant>;

export type SheetVariantName = keyof typeof SHEET_VARIANTS;

export const SHEET_VARIANT_NAMES = Object.keys(SHEET_VARIANTS) as SheetVariantName[];

// Read through the WIDE interface. `as const satisfies` keeps the key names literal (which is
// what the parser validates against), but it also narrows each entry to its own exact shape,
// so `.retry` does not exist on the refusals that omit it.
export function sheetVariant(name: SheetVariantName): SheetVariant {
  return SHEET_VARIANTS[name];
}

// `?sheet=<name>`; bare `?sheet` or `?sheet=1` takes the reported one, which is the variant
// anybody arriving here without a name in mind is looking for.
export function sheetPreviewFromSearch(
  search: string,
  dev = import.meta.env.DEV,
): SheetVariantName | null {
  if (!dev) return null;
  const raw = new URLSearchParams(search).get('sheet');
  if (raw == null) return null;
  if (raw === '' || raw === '1') return 'account';
  return (SHEET_VARIANT_NAMES as string[]).includes(raw) ? (raw as SheetVariantName) : null;
}

// Closing CYCLES rather than dismissing, and TRY AGAIN re-opens the same one. A design
// conversation is a series of looks at the box, so the two controls are the fastest way to
// walk the copy set — and a preview that vanished on the first tap would cost a reload per
// look. The real sheet's own handlers are what they are; nothing here changes the component.
export function nextSheetVariant(held: SheetVariantName): SheetVariantName {
  const at = SHEET_VARIANT_NAMES.indexOf(held);
  return SHEET_VARIANT_NAMES[(at + 1) % SHEET_VARIANT_NAMES.length];
}
