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
import { commandIds, type OutboundQueue } from '../outbound/commands';
import type { DeclarationStore, Declaration } from './declarations';
import type { LeaderStore } from './leader';
import type { InboundMessage } from './message';
import { displayName } from './names';
import { renderLeader } from './podiumText';
import { reactionFor } from './reactions';
import { sharesIn } from './share';

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
        return 'failed';
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
      if (!message.live) continue;

      if (group.reactions) {
        await deps.outbound.enqueue({
          id: commandIds.reaction(group.id, message.id),
          kind: 'reaction',
          group: group.id,
          target: { id: message.id, participant: message.sender },
          emoji: reactionFor(share.score, share.capped),
        });
      }
      if (group.leaderAnnouncements && !share.capped) {
        const lead = await deps.leaders.claim(
          group.id,
          share.dayNumber,
          message.sender,
          share.score,
        );
        if (lead === 'took_lead') {
          const name = displayName(group, message.sender, message.senderName);
          await deps.outbound.enqueue({
            id: commandIds.leader(group.id, share.dayNumber, message.sender, share.score),
            kind: 'message',
            group: group.id,
            text: renderLeader(name, share.score, group.language),
          });
        }
      }
    }
    return outcome;
  };
}
