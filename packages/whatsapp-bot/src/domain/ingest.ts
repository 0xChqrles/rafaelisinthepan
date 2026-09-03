// The per-message pipeline (#236): allow-list → share links → durable declaration →
// deterministic reaction → (optionally) the new-leader line. No model anywhere here; a
// message that carries no valid share for this group's language does nothing at all.
//
// A Dynamo failure is RETRIED, not reacted past: "Do not react as though the score was
// recorded." Baileys delivers a live message once, so a write that fails for good is a
// lost share the log says so about — the accepted integration failure, made visible.

import type { GroupRegistry } from '../config/groupConfig';
import type { Log } from '../log';
import { tag } from '../log';
import { commandIds, type OutboundCommand, type OutboundQueue } from '../outbound/commands';
import type { DeclarationStore, Declaration } from './declarations';
import type { LeaderStore } from './leader';
import type { InboundMessage } from './message';
import { displayName } from './names';
import { renderLeader } from './podiumText';
import { reactionFor } from './reactions';
import { sharesIn, type DecodedShare } from './share';

// How good a result is, for picking the one a message is acknowledged for: lower is
// better, and a run that ended at ∞ is behind every finite score.
const rankOf = (share: DecodedShare) => (share.capped ? Infinity : share.score);

export interface IngestDeps {
  groups: GroupRegistry;
  declarations: DeclarationStore;
  outbound: OutboundQueue;
  leaders: LeaderStore;
  siteOrigin: string;
  log: Log;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

export type IngestOutcome = 'ignored' | 'no_share' | 'recorded' | 'unchanged' | 'failed';

const WRITE_ATTEMPTS = 3;

export function createIngest(deps: IngestDeps) {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  async function recordWithRetry(declaration: Declaration) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await deps.declarations.record(declaration);
      } catch (error) {
        if (attempt + 1 >= WRITE_ATTEMPTS) throw error;
        await wait(200 * 2 ** attempt * (0.5 + Math.random()));
      }
    }
  }

  return async function ingest(message: InboundMessage): Promise<IngestOutcome> {
    const group = deps.groups.get(message.group);
    if (!group || message.fromMe) return 'ignored';
    const shares = sharesIn(message.text, deps.siteOrigin);
    // One declaration per day per message: a message pasting two tokens of one day means
    // the last one (the same message id cannot supersede itself).
    const byDay = new Map<number, (typeof shares)[number]>();
    for (const share of shares) {
      if (share.lang !== group.language) {
        deps.log.info(
          { event: 'share.other_language', lang: share.lang, group: tag(group.id) },
          'ignoring a share of another language',
        );
        continue;
      }
      byDay.set(share.dayNumber, share);
    }
    if (byDay.size === 0) return 'no_share';

    let outcome: IngestOutcome = 'unchanged';
    let failed = false;
    const recorded: DecodedShare[] = [];
    const announcements: OutboundCommand[] = [];
    for (const share of byDay.values()) {
      const declaration: Declaration = {
        group: group.id,
        dayNumber: share.dayNumber,
        sender: message.sender,
        score: share.score,
        capped: share.capped,
        token: share.token,
        messageId: message.id,
        messageTs: message.timestamp,
        name: message.senderName,
        receivedAt: now().toISOString(),
        lang: share.lang,
      };
      let result;
      try {
        result = await recordWithRetry(declaration);
      } catch (error) {
        deps.log.error(
          {
            event: 'share.write_failed',
            group: tag(group.id),
            sender: tag(message.sender),
            messageId: message.id,
            error: (error as Error).message,
          },
          'could not record a share; the podium may be incomplete',
        );
        // One day's write failing is no reason to abandon the other day this same message
        // carries: WhatsApp delivers it once, so what is skipped here is simply lost.
        failed = true;
        continue;
      }
      deps.log.info(
        {
          event: 'share.' + result,
          group: tag(group.id),
          sender: tag(message.sender),
          messageId: message.id,
          day: share.dayNumber,
          score: share.capped ? 'capped' : share.score,
          live: message.live,
        },
        'share',
      );
      if (result !== 'recorded') continue;
      outcome = 'recorded';
      recorded.push(share);

      if (group.leaderAnnouncements && !share.capped) {
        // THE CLAIM RUNS ON A REPLAY TOO. The row holds the day's best, so a replayed
        // share that left it stale would have the next live one announce a lead it does
        // not hold. Only the ANNOUNCEMENT is live-only: history is not news.
        const lead = await deps.leaders.claim(
          group.id,
          share.dayNumber,
          message.sender,
          share.score,
        );
        if (lead === 'took_lead' && message.live) {
          const name = displayName(group, message.sender, message.senderName);
          announcements.push({
            id: commandIds.leader(group.id, share.dayNumber, message.sender, share.score),
            kind: 'message',
            group: group.id,
            text: renderLeader(name, share.score, group.language),
          });
        }
      }
    }

    // ONE reaction per MESSAGE, whatever it carried. WhatsApp holds a single reaction per
    // account per message and the command id is keyed by the message, so queueing one per
    // DAY would leave an arbitrary survivor to decide the emoji. The best result the
    // message showed is the one it is acknowledged for; a ∞ run is the worst of them.
    const best = recorded.reduce<DecodedShare | null>(
      (kept, share) => (kept && rankOf(kept) <= rankOf(share) ? kept : share),
      null,
    );
    if (group.reactions && message.live && best) {
      await deps.outbound.enqueue({
        id: commandIds.reaction(group.id, message.id),
        kind: 'reaction',
        group: group.id,
        target: { id: message.id, participant: message.sender },
        emoji: reactionFor(best.score, best.capped),
      });
    }
    // After the reaction, so the acknowledgement lands before the commentary.
    for (const announcement of announcements) await deps.outbound.enqueue(announcement);
    return failed ? 'failed' : outcome;
  };
}
