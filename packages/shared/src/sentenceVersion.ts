// WHICH VERSION of a published sentence a page holds (user-decided 2026-10-13: "they need to
// have an instant reload when there's a new sentence"). A republish mints a new `revision`
// (#203), and a page still showing the retired one learns it two ways: `/round` answers a
// write naming a retired revision with PUZZLE_CHANGED (409), and the puzzle response carries
// its revision as its ETag, so a page can ask the CDN whether its sentence is still the
// published one — an unchanged sentence answers 304, never the megabytes again. The backend
// writes both, the web reads both and reloads onto the new sentence.

// The error CODE of a `/round` write naming a revision the store no longer publishes — told
// apart from the 404 of a day with no puzzle at all.
export const PUZZLE_CHANGED = 'puzzle_changed';

// The puzzle response's ETag: its revision, quoted. A strong validator: the revision is a hash
// of the complete content.
export function revisionEtag(revision: string): string {
  return `"${revision}"`;
}

// The revision an ETag names, or null. A weak prefix is read through: a cache in between may
// weaken a validator without changing what it names.
export function etagRevision(etag: string | null | undefined): string | null {
  const match = /^(?:W\/)?"([^"]+)"$/.exec((etag ?? '').trim());
  return match ? match[1] : null;
}
