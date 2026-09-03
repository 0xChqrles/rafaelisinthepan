# AGENTS.md — @whippin/whatsapp-bot (group scoreboard bot, #236)

> Package-scoped guidance. The root `AGENTS.md` applies here too — engineering
> principles, testing policy, the issue/PR workflow, and the **cross-package boundary of
> this bot** (its own section there). Read it first.

The bot is a SOCIAL CONSUMER of Whippin's public share-token contract: one always-on
WhatsApp account that records valid `…/s/<token>` shares as they arrive in configured
groups, posts each group's daily podium, reacts deterministically, and answers when
addressed — using the group's Whippin history as TOOLS, never as prose the model
remembers. It lives inside the monorepo and outside the game runtime: it imports
`@whippin/shared`; nothing in the game imports it.

## File map

```
  whatsapp-bot/
    groups/*.json               THE ALLOW-LIST: one committed config per group (product
                                behaviour, never a secret). No file → the group does not exist.
    src/config/groupConfig.ts   strict parser + GroupRegistry (enabled groups by JID)
    src/config/env.ts           runtime env: table, queue URL, groups dir, site origin, LLM knobs
    src/log.ts                  pino + `tag()` — the ONE hashing of a JID for logs
    src/domain/                 Whippin-side logic, Baileys-free:
      message.ts                InboundMessage — the bot's own inbound shape
      share.ts                  find + decode share links (sentence tokens only)
      day.ts                    parseDay — a "YYYY-MM-DD" a human or a model supplied, round-tripped
                                through the shared pair so "2026-02-30" is refused, not rolled over
      declarations.ts           Declaration, the PRECEDENCE rule (`supersedes`), `inLanguage`, store interface, memory impl
      dynamoDeclarationStore.ts GROUP#<jid> / DAY#<000000>#PLAYER#<sender>; precedence as a ConditionExpression
      podium.ts                 DENSE podium (1, 2, 2 → 3); ∞ runs listed, never positioned
      podiumText.ts             the renderer (positions/names/scores/framing are ITS; comments keyed by line id)
      names.ts                  display name = operator override ?? latest snapshot ?? …last4
      reactions.ts              score band → emoji, no model
      leader.ts                 the new-leader event + its anti-spam row (LEAD#<day>)
      ingest.ts                 the per-message pipeline: allow-list → share → durable row → reaction/leader
    src/outbound/               ONE owner of sends: commands (ids), SQS transport, sent-record dedup, dispatcher
    src/llm/                    provider-neutral contract (types.ts), providers/deepseek.ts, the versioned
                                personality, podium comments (validated, retried, degrade to none)
    src/chat/                   addressed conversation: trigger (mention/reply/name), ceilings (limits),
                                in-memory recent context, durable social memory, read-only tools + name
                                resolution (one window constant: a tool never promises days it
                                cannot read), the bounded tool-loop agent
    src/whatsapp/               the Baileys boundary: inbound mapping, durable auth (DynamoDB), the
                                single-session lease + the keeper that stops a holder whose renewals
                                stop landing, the socket wrapper (reconnect/stop policy), metrics
    src/main.ts                 the Fargate task entry
    src/podiumJob.ts            the Lambda entry (EventBridge Scheduler → podium command on the queue)
    src/pair.ts, src/cli.ts     operator paths: pairing (QR / code), `groups` listing, `forget`
    scripts/bundle.mjs          esbuild bundle of main.ts for the image (deps external)
    Dockerfile                  built from the REPO ROOT (see the root .dockerignore whitelist)
```

## Invariants (decided in #236)

- **No config, no behaviour.** `groups/*.json` is the allow-list for ingestion, reactions,
  conversation AND scheduled messages (the stack reads it at synth to create one schedule
  per enabled podium). `language` decides which daily's shares count — an `fr` group ranks
  the French puzzle and ignores an English token — on the way IN and on the way OUT: every
  read of the declarations goes through `inLanguage`, so a group whose configured language
  changes does not rank the rows it wrote under the old one. Files hold product behaviour
  only; the loader refuses unknown fields so a typo cannot fall back to a default.
- **ONE session.** `desiredCount 1`, stop-before-start deploys, and the DynamoDB LEASE
  (`AUTH#bot / lease`) that a laptop `bot:start`, `bot:pair` or `bot:cli groups` must hold
  to open a socket. Scale the service to 0 before pairing; the lease refusing is the point.
  A holder stops when the lease is REFUSED and also when its renewals simply stop landing
  for `LEASE_GRACE_MS` — a renew that throws is not a renew, and the record ages out either
  way. `keepLease` is that rule, once, for both entry points. `wipe()` keeps the lease row.
- **Auth is durable and never auto-replaced.** Creds + Signal keys live in the bot table
  (`whatsapp/authStore.ts`, Baileys' own `BufferJSON`). A logout marks `AUTH#bot / status`
  INVALIDATED and the task idles with the connected gauge at 0; nothing erases or re-mints
  a session. `pnpm bot:pair` (with `--reset` to wipe) is the only way back.
- **A share is deterministic input.** The token's day and score, decoded with the shared
  codec; the WhatsApp receive date never groups a result. Word-mode tokens are ignored.
  The sender JID (phone-number form preferred over a LID) is the player key; names are a
  snapshot. Precedence: same message twice = no-op; a later message with a different token
  replaces; order by message timestamp, message id as the tie-break. Not an anti-cheat.
- **The podium is DENSE and the renderer owns everything but the comments.** Never
  `rankBoard` from shared (competition ranks belong to the public board). A model returns
  `{lines:[{id, comment}]}` keyed by line id (= the score); the answer is rejected whole on
  a missing/duplicate/unknown id or a non-plain/over-long comment, retried once, then the
  podium ships with no comments. Unavailable model = scoreboard without jokes, never no
  scoreboard.
- **Outbound has one owner.** Every send is a command with an id (`podium:<g>:<day>`,
  `react:<g>:<msg>`, `reply:<g>:<msg>`, `leader:…`) on the SQS queue; the task's
  dispatcher checks the sent record, sends, records the WhatsApp id. The send-then-crash
  duplicate window is accepted over marking before sending. The sent record catches a
  REDELIVERY and nothing longer-lived, so it wears the table's TTL (30 days) rather than
  accumulating a permanent row per message ever sent. ONE reaction per MESSAGE, for the
  best result it carried — the id is keyed by the message, and WhatsApp holds one reaction
  per account anyway. A leader row is keyed by (group, LANGUAGE, day) and moves on every
  improvement and on a REPLAY, so history cannot make a later share announce a lead it does
  not hold; only a change of HOLDER is announced, read from what the write DISPLACED rather
  than from a stale read (`leader.ts` says why). A claim that fails is logged and dropped —
  the announcement is decoration, the acknowledgement is not. **The consumer does not
  receive while the socket is down**: a redelivery counts against the queue's
  `maxReceiveCount`, so pulling what cannot be sent turns a reconnection into a
  dead-letter alarm.
- **Conversation is opt-in per message**: mention, reply-to-bot, or a leading `chat.name`.
  Nothing else reaches the model. Ceilings: per sender/day and per group/day (config), each
  charged once per QUESTION and only once there is one to answer; plus
  `BOT_LLM_DAILY_CALL_CEILING`, which counts model CALLS, so one question spends as many of
  it as its tool rounds take. The model reads game facts ONLY
  through the allow-listed tools; name resolution is the tool runner's, and ambiguity is
  answered as such. Memory is bounded facts per (group, JID), written from explicit
  interactions; `bot:cli forget` removes it without touching scoreboard rows.
- **Privacy:** logs carry event kinds, hashed JIDs (`tag()`), message ids, day/score and
  provider latency — never a message body. A command id EMBEDS the JIDs it addresses, so
  every log of one goes through `redactJids`. Score-only shares never reach the provider.
- **Baileys stops at `whatsapp/`.** The rest consumes `InboundMessage` / `OutboundCommand`.
- **The image is built from the REPO ROOT** against the root `.dockerignore`, whose
  whitelist names every directory it re-includes outright: a re-include rescues an excluded
  directory only when it LITERALLY starts with that directory's path, so a wildcard in the
  middle silently drops it under the legacy builder (measured: five of the seven workspace
  manifests, and the frozen install then fails). **A new workspace package needs a line
  there**, the same duty as wiring it into `deploy.yml`.

## Commands

```bash
pnpm bot:start        # run the task locally (needs AWS creds, BOT_TABLE; takes the lease)
pnpm bot:pair         # print the QR (or --phone <digits> for a pairing code); --reset to wipe first
pnpm bot:cli groups   # list the paired account's groups with their JIDs
pnpm bot:cli forget <group JID> <player JID>
pnpm bot:build        # bundle main.ts into dist/ (what the Dockerfile runs)
pnpm --filter @whippin/whatsapp-bot test
```

Env: `BOT_TABLE` (required), `BOT_OUTBOUND_QUEUE_URL` (absent = in-process queue, local
only), `BOT_GROUPS_DIR`, `BOT_SITE_ORIGIN`, `BOT_METRICS_NAMESPACE`, `BOT_LLM_PROVIDER`,
`BOT_LLM_MODEL`, `BOT_LLM_API_KEY_PARAMETER` (SSM) or `BOT_LLM_API_KEY` (local only),
`BOT_LLM_DAILY_CALL_CEILING`, `BOT_LOG_LEVEL`, `BOT_BAILEYS_LOG_LEVEL`.

## Current state / mutable

- `groups/test.json` is the first target and ships DISABLED with a placeholder JID: fill in
  the real test-group JID (`pnpm bot:cli groups`) and flip `enabled` once paired. The
  production group is a later, separate config change after reconnect, ingestion, dedup and
  outbound behaviour have been exercised there.
- The transport proof (pair → receive → reply → kill the task → reconnect without pairing)
  has NOT been run yet; it needs the dedicated number and a deployed stack.
- The IMAGE has been built and run (2026-09-03): 113 files / 884 KB of context, identical
  under BuildKit and the legacy builder, and the container starts far enough to refuse its
  missing `BOT_TABLE`. What that does not cover is WhatsApp itself.
- Baileys is pinned to `7.0.0-rc14` (its `prepare` build script and protobufjs' postinstall
  are declined in `pnpm-workspace.yaml`; the package ships prebuilt). `sharp` arrives as
  its non-optional peer.
- Proactive new-leader lines are implemented behind `leaderAnnouncements` (default off).
- Not built: the eval fixture for comparing models, a manual replay/rebuild of ingestion,
  bot commands beyond addressing, durable interaction records for summarisation.

## Do NOT

- Don't import Baileys outside `src/whatsapp/` (and never in `podiumJob.ts` — it is
  bundled into a Lambda that must never open a socket).
- Don't let the model decide a score, a rank, or whether a share is valid.
- Don't add `if (groupId === …)` logic — it is a config field or nothing.
- Don't put a secret in `groups/*.json` or the task/Lambda environment.
- Don't log message bodies or raw JIDs.
