import { activeDate, dayNumber } from '@whippin/shared';

// The current game day's stable id, computed LOCALLY: the client owns the same
// DST-correct 22:00-ET day logic as the server (shared day.ts), so there is nothing to
// fetch — and nothing to go stale in a tab left open across the flip (each render
// re-reads the clock). The selector uses it to build each language's roundKey and read
// its persisted status.
export default function useToday(): number {
  return dayNumber(activeDate(new Date()));
}
