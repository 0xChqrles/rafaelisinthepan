import type { UiKey } from '../i18n';

// Development-only preview of the app's ONE error surface (`components/ErrorScreen`), so its
// design can be looked at and argued about without having to break a real request first.
// The `?streak=N` harness's rules, for its reasons: parsing is pure and injectable so a test
// can prove a PRODUCTION build ignores the parameter even when it is otherwise valid.
//
// Every variant here is a REAL call site's (title, note) pair — never invented copy. That is
// the whole point of previewing on this surface rather than on a mock: what the box has to
// survive is the copy it actually carries, from the longest note to the shortest. (Until
// 2026-09-03 a variant also said whether it carried TRY AGAIN; the screen has one way out
// now, so a variant is only its words.)
export interface ErrorVariant {
  title: UiKey;
  note: UiKey;
}

export const ERROR_VARIANTS = {
  // The one production reported on 2026-08-27, and the longest note.
  account: { title: 'failedAccount', note: 'failedAccountNote' },
  share: { title: 'failedShare', note: 'failedShareNote' },
  start: { title: 'failedStart', note: 'failedStartNote' },
  invite: { title: 'failedInvite', note: 'failedInviteNote' },
  save: { title: 'profileSaveFailed', note: 'failedSaveNote' },
  name: { title: 'profileNameRejected', note: 'profileNameRejectedNote' },
  avatar: { title: 'profileAvatarRejected', note: 'profileAvatarRejectedNote' },
} as const satisfies Record<string, ErrorVariant>;

export type ErrorVariantName = keyof typeof ERROR_VARIANTS;

export const ERROR_VARIANT_NAMES = Object.keys(ERROR_VARIANTS) as ErrorVariantName[];

// Read through the WIDE interface: `as const satisfies` keeps the key names literal (which is
// what the parser validates against) while narrowing each entry to its own exact shape.
export function errorVariant(name: ErrorVariantName): ErrorVariant {
  return ERROR_VARIANTS[name];
}

// `?error=<name>`; bare `?error` or `?error=1` takes the reported one, which is the variant
// anybody arriving here without a name in mind is looking for.
export function errorPreviewFromSearch(
  search: string,
  dev = import.meta.env.DEV,
): ErrorVariantName | null {
  if (!dev) return null;
  const raw = new URLSearchParams(search).get('error');
  if (raw == null) return null;
  if (raw === '' || raw === '1') return 'account';
  return (ERROR_VARIANT_NAMES as string[]).includes(raw) ? (raw as ErrorVariantName) : null;
}

// Closing CYCLES rather than dismissing. A design conversation is a series of looks at the
// box, so the one control is the fastest way to walk the copy set — a preview that vanished
// on the first tap would cost a reload per look. The screen's own handler is what it is;
// nothing here changes the component.
export function nextErrorVariant(held: ErrorVariantName): ErrorVariantName {
  const at = ERROR_VARIANT_NAMES.indexOf(held);
  return ERROR_VARIANT_NAMES[(at + 1) % ERROR_VARIANT_NAMES.length];
}
