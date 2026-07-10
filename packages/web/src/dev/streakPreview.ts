export const MAX_STREAK_PREVIEW = 99_999;

// Development-only streak animation preview. The query value is the BEFORE value, so
// ?streak=9 exercises 9 -> 10. Keep parsing pure/injectable so tests can prove that a
// production build ignores the parameter even when it is otherwise valid.
export function streakPreviewFromSearch(
  search: string,
  dev = import.meta.env.DEV,
): number | null {
  if (!dev) return null;
  const raw = new URLSearchParams(search).get('streak');
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_STREAK_PREVIEW ? value : null;
}
