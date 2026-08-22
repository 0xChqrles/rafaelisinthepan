import { ROUND_GUESS_CAP, ROUND_WRITE_MIN_MS } from '@whippin/shared';
import {
  roundPartition,
  roundSortKey,
  type RoundAppendInput,
  type RoundKey,
  type RoundState,
  type RoundStore,
} from './roundStore';

interface RoundItem {
  guesses: string[];
  puzzle: string;
  createdAt: string;
  lastWriteAt: number;
  // Word mode's server-stamped clock (#202); absent on a sentence round.
  startedAt?: string;
  // When the end-of-run log was RECORDED — the submission's own marker, never the log's
  // length (roundStore.ts: a 0-claim run records an empty log).
  submittedAt?: string;
  // The summary the server DERIVED from the log beside it (#203). `solved` is only ever
  // written true, and its presence is what freezes further appends.
  progress?: number;
  solved?: boolean;
}

// Process-local store for `pnpm backend:dev`: the same RoundStore contract as DynamoDB —
// one append-or-refuse decision per write under both bounds, plus the puzzle-identity
// restart, plus Word mode's two writes (#202) — with no AWS account. Restarting the local server intentionally resets this lab
// data. The bound constants are imported from @whippin/shared rather than parameterized, so
// this implementation cannot drift from the production condition it mirrors.
export function memoryRoundStore(): RoundStore {
  const rounds = new Map<string, RoundItem>();
  const itemKey = (key: RoundKey, publicId: string) =>
    `${roundPartition(publicId)}/${roundSortKey(key)}`;

  const stateOf = (item: RoundItem): RoundState => ({
    guesses: [...item.guesses],
    createdAt: item.createdAt,
    // ABSENT rather than empty when unstamped, the Dynamo store's rule: the submit's "is
    // there a run to end?" test reads exactly this, and `submittedAt` is what says the run
    // was recorded.
    ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
    ...(item.submittedAt === undefined ? {} : { submittedAt: item.submittedAt }),
    ...(item.progress === undefined ? {} : { progress: item.progress }),
    ...(item.solved === true ? { solved: true } : {}),
  });

  // The state a caller may be TOLD about, which is only ever the state of the puzzle it
  // asked about. A record naming a different one holds the RETIRED sentence's log, and
  // every answer — the refusals included — is adopted by the client as this round's
  // truth: handing that log back on a rate-refused restart would reintroduce exactly the
  // guesses the tag exists to exclude. (dynamoRoundStore.ts keeps the same rule.)
  const stateForTag = (item: RoundItem | undefined, puzzle: string): RoundState =>
    item && item.puzzle === puzzle ? stateOf(item) : empty();

  return {
    async get(key, publicId, puzzle) {
      const item = rounds.get(itemKey(key, publicId));
      // A record naming a DIFFERENT puzzle is an honest "nothing stored for this one"
      // (roundStore.ts): the daily was re-published under the same key.
      if (!item || item.puzzle !== puzzle) return null;
      return stateOf(item);
    },

    async append(input: RoundAppendInput) {
      const id = itemKey(input, input.publicId);
      const existing = rounds.get(id);
      const nowMs = input.now.getTime();
      const paced = !existing || existing.lastWriteAt < nowMs - ROUND_WRITE_MIN_MS;
      // `solved` is only ever written TRUE (roundStore.ts), so an unsolved append leaves
      // whatever is there alone — which, on this branch, is never `true` anyway.
      const derived = { progress: input.progress, ...(input.solved ? { solved: true } : {}) };

      // The route never sends an over-cap batch, but the store owns the invariant:
      // refuse rather than create (or restart) a record born past the cap.
      if (input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full' as const, state: stateForTag(existing, input.puzzle) };
      }

      // A RETIRED puzzle's log: the round restarted under the same key, so the batch
      // REPLACES it rather than growing it — the retired puzzle's derived summary included,
      // or its `solved` would freeze a round nobody is playing any more. The interval still
      // applies, otherwise varying the tag would be a way around the rate bound.
      if (!existing || existing.puzzle !== input.puzzle) {
        // The refusal answers with the state of the puzzle that was ASKED about — never
        // the retired one's log, which the client would adopt as this round's truth (the
        // note in `stateForTag` below).
        if (existing && !paced) return { outcome: 'too_fast' as const, state: empty() };
        const item: RoundItem = {
          guesses: [...input.guesses],
          puzzle: input.puzzle,
          createdAt: input.now.toISOString(),
          lastWriteAt: nowMs,
          ...derived,
        };
        rounds.set(id, item);
        return { outcome: 'appended' as const, state: stateOf(item) };
      }

      // Solved first, then cap, then interval — the same order the Dynamo classification
      // reads them in, so a doubly-refused append answers alike on both backends.
      if (existing.solved) {
        return { outcome: 'round_solved' as const, state: stateOf(existing) };
      }
      if (existing.guesses.length + input.guesses.length > ROUND_GUESS_CAP) {
        return { outcome: 'round_full' as const, state: stateOf(existing) };
      }
      if (!paced) return { outcome: 'too_fast' as const, state: stateOf(existing) };
      existing.guesses.push(...input.guesses);
      existing.lastWriteAt = nowMs;
      Object.assign(existing, derived);
      return { outcome: 'appended' as const, state: stateOf(existing) };
    },

    // The corrective write (#203): the summary derived from the log the append actually
    // produced. A record naming a different puzzle has already restarted and has nothing
    // here to correct, and progress only ever RISES — the Dynamo store's monotonicity
    // clause, restated here so both backends refuse the same stale correction.
    async settle(input) {
      const item = rounds.get(itemKey(input, input.publicId));
      if (!item || item.puzzle !== input.puzzle) return;
      if (item.progress !== undefined && item.progress > input.progress) return;
      item.progress = input.progress;
      if (input.solved) item.solved = true;
    },

    // Word mode's round START (#202): stamp the server clock, once per puzzle. A record
    // naming a RETIRED word restarts — its log goes with its old clock — and one already
    // stamped for THIS word keeps its original start, so a double tap, a retry and a second
    // device all resume the one run.
    async start(input) {
      const id = itemKey(input, input.publicId);
      const existing = rounds.get(id);
      if (existing && existing.puzzle === input.puzzle && existing.startedAt !== undefined) {
        return { outcome: 'running' as const, state: stateOf(existing) };
      }
      const stampedAt = input.now.toISOString();
      const item: RoundItem = {
        guesses: [],
        puzzle: input.puzzle,
        createdAt: stampedAt,
        // Word paths leave the streaming interval alone (roundStore.ts).
        lastWriteAt: existing?.lastWriteAt ?? 0,
        startedAt: stampedAt,
      };
      rounds.set(id, item);
      return { outcome: 'started' as const, state: stateOf(item) };
    },

    // Word mode's end-of-run SUBMIT (#202): the whole log, first write wins, never before
    // the run's own floor.
    async submit(input) {
      const existing = rounds.get(itemKey(input, input.publicId));
      const stored = existing && existing.puzzle === input.puzzle ? existing : undefined;
      if (!stored || stored.startedAt === undefined) {
        return { outcome: 'not_started' as const, state: empty() };
      }
      // `submittedAt`, never the log's length: a run that claimed nothing records an EMPTY
      // log, and reading that back as "nothing recorded" would let a second submission
      // overwrite it — first-write-wins broken for exactly the rounds with least to say.
      if (stored.submittedAt !== undefined) {
        return { outcome: 'already_submitted' as const, state: stateOf(stored) };
      }
      if (input.now.getTime() - Date.parse(stored.startedAt) < input.minElapsedMs) {
        return { outcome: 'too_early' as const, state: stateOf(stored) };
      }
      stored.guesses = [...input.guesses];
      stored.submittedAt = input.now.toISOString();
      return { outcome: 'submitted' as const, state: stateOf(stored) };
    },
  };
}

function empty(): RoundState {
  return { guesses: [], createdAt: '' };
}
