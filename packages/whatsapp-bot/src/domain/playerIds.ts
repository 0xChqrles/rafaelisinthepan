// WHO IS WHO (user-decided 2026-10-30): which WhatsApp member is which Whippin account, per
// group, so the share line can read the sharer's own round and the conversation can say
// "Gab (Gabriel on WhatsApp)". The ONLY thing the bot stores about the rounds it reads —
// the rounds themselves stay in memory for a minute (`puzzle/groupRounds.ts`).
//
// LEARNT FROM A SIGNED SHARE, AND ONLY ONCE THE GAME AGREES. The web signs every share with
// its player's publicId (`/s/<token>/<publicId>`), and anybody can paste anybody's link, so
// the id is a CLAIM. It is believed when the Whippin group's rounds for the share's own
// (language, day) hold that id as a member AND that member's round says what the token says
// — solved in exactly the token's tries, or ended unsolved (∞) for a capped token
// (`agrees`). Anything else is not stored, and logged by kind. A FORWARDED share is never
// learnt from: its link is somebody else's result. THE LATEST VERIFIED SHARE WINS (by the
// message's own timestamp, as a ConditionExpression), so a member who links a new account
// is followed.
//
// ONE ROW PER (GROUP, SENDER): `PLAYERID#<group>` / `<sender>` → the publicId, the sender's
// name snapshot (what the conversation calls them on WhatsApp) and the message's timestamp.
// No TTL, and NO LONGER THAN THE MEMBERSHIP: a row whose account a successful rounds read
// no longer names as a member (left the Whippin group, or deleted the account) is deleted
// by the next live state that sees it (`pruneLinks`).

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { dateForDayNumber, type BotMemberRound } from '@whippin/shared';
import type { GroupConfig } from '../config/groupConfig';
import type { Log } from '../log';
import { tag } from '../log';
import type { GroupRoundsReader } from '../puzzle/groupRounds';
import type { InboundMessage } from './message';
import { displayName } from './names';
import type { DecodedShare } from './share';

export interface PlayerLink {
  sender: string;
  publicId: string;
  name: string; // the sender's WhatsApp name snapshot at that share
  messageTs: number;
}

export interface PlayerIdStore {
  // Written unless a LATER verified share already stands for that sender.
  put(group: string, link: PlayerLink): Promise<void>;
  get(group: string, sender: string): Promise<PlayerLink | null>;
  list(group: string): Promise<PlayerLink[]>;
  delete(group: string, sender: string): Promise<void>;
}

// THE ROUND SAYS WHAT THE TOKEN SAYS. A solved round in exactly the token's tries, or a
// capped token over a round that ended unsolved. A round still in play agrees with nothing:
// a share is only ever made of a round that is over.
export function agrees(member: BotMemberRound, share: Pick<DecodedShare, 'score' | 'capped'>): boolean {
  return share.capped ? member.over && !member.solved : member.solved && member.tries === share.score;
}

export type SharerLookup = (group: GroupConfig, share: DecodedShare, message: InboundMessage) => Promise<BotMemberRound | null>;

// THE SHARER'S ROUND, when the bot knows who they are and the round matches the share: the
// signature verified (and then remembered), or the sender's stored link. Null otherwise —
// a group with no Whippin group, a read that failed, a claim the rounds do not back.
export function createSharerLookup(deps: { rounds: GroupRoundsReader; playerIds: PlayerIdStore; log: Log }): SharerLookup {
  return async (group, share, message) => {
    if (!group.whippinGroup) return null;
    // FRESH: the round the share is about has just ended, and a held answer predates it.
    const rounds = await deps.rounds.read(group.whippinGroup, share.lang, dateForDayNumber(share.dayNumber), { fresh: true });
    if (!rounds) return null;
    const unverified = (reason: string) => {
      deps.log.info({ event: 'players.unverified', reason, group: tag(group.id), sender: tag(message.sender) }, 'the share names nobody the bot can confirm');
      return null;
    };
    if (share.publicId) {
      const member = rounds.members.find((m) => m.publicId === share.publicId);
      if (!member) return unverified('not_member');
      if (!agrees(member, share)) return unverified('disagrees');
      if (message.forwarded) return unverified('forwarded');
      try {
        await deps.playerIds.put(group.id, { sender: message.sender, publicId: member.publicId, name: message.senderName, messageTs: message.timestamp });
        deps.log.info({ event: 'players.linked', group: tag(group.id), sender: tag(message.sender) }, 'sender linked to their account');
      } catch (error) {
        // The mapping is lost, the line about this share is not.
        deps.log.warn({ event: 'players.write_failed', group: tag(group.id), error: (error as Error).message }, 'could not store who is who');
      }
      return member;
    }
    let link: PlayerLink | null;
    try {
      link = await deps.playerIds.get(group.id, message.sender);
    } catch (error) {
      deps.log.warn({ event: 'players.read_failed', group: tag(group.id), error: (error as Error).message }, 'could not read who is who');
      return null;
    }
    if (!link) return null;
    const member = rounds.members.find((m) => m.publicId === link.publicId);
    // A known member whose round says something else shared a result that is not theirs.
    return member && agrees(member, share) ? member : null;
  };
}

// THE PODIUM'S PLAYERS AS THE WHIPPIN GROUP KNOWS THEM: each poster linked to an account
// whose round of that day agrees with what they posted, by sender. One rounds read and one
// read of the links; anybody unlinked or disagreeing is simply not in the map. Never throws.
export async function verifiedRoundsOf(
  deps: { rounds: GroupRoundsReader; playerIds: PlayerIdStore; log: Log },
  group: GroupConfig,
  lang: string,
  dayNumber: number,
  posted: readonly { sender: string; score: number; capped: boolean }[],
): Promise<Map<string, BotMemberRound>> {
  const found = new Map<string, BotMemberRound>();
  if (!group.whippinGroup || posted.length === 0) return found;
  try {
    const [rounds, links] = await Promise.all([deps.rounds.read(group.whippinGroup, lang, dateForDayNumber(dayNumber)), deps.playerIds.list(group.id)]);
    if (!rounds) return found;
    const byId = new Map(rounds.members.map((m) => [m.publicId, m]));
    const idOf = new Map(links.map((l) => [l.sender, l.publicId]));
    for (const row of posted) {
      const member = byId.get(idOf.get(row.sender) ?? '');
      if (member && agrees(member, row)) found.set(row.sender, member);
    }
  } catch (error) {
    deps.log.warn({ event: 'players.read_failed', group: tag(group.id), error: (error as Error).message }, 'could not read who is who');
  }
  return found;
}

// THE LINKS OF ACCOUNTS NO LONGER IN THE GROUP, deleted: the rounds read names every member
// (a gone account already dropped), so a link to anybody else is consent withdrawn. Never
// throws; a failed delete is logged and tried again by the next read.
export async function pruneLinks(
  deps: { playerIds: PlayerIdStore; log: Log },
  group: GroupConfig,
  members: readonly BotMemberRound[],
  links: readonly PlayerLink[],
): Promise<void> {
  const ids = new Set(members.map((m) => m.publicId));
  for (const link of links) {
    if (ids.has(link.publicId)) continue;
    try {
      await deps.playerIds.delete(group.id, link.sender);
      deps.log.info({ event: 'players.unlinked', group: tag(group.id), sender: tag(link.sender) }, 'link to a former member deleted');
    } catch (error) {
      deps.log.warn({ event: 'players.delete_failed', group: tag(group.id), error: (error as Error).message }, 'could not delete a former member\'s link');
    }
  }
}

function partition(group: string): string {
  return `PLAYERID#${group}`;
}

function fromItem(item: Record<string, AttributeValue>): PlayerLink {
  return {
    sender: item.sk?.S ?? '',
    publicId: item.publicId?.S ?? '',
    name: item.name?.S ?? '',
    messageTs: Number(item.messageTs?.N ?? 0),
  };
}

export function dynamoPlayerIdStore(client: DynamoDBClient, tableName: string): PlayerIdStore {
  return {
    async put(group, link) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              pk: { S: partition(group) },
              sk: { S: link.sender },
              publicId: { S: link.publicId },
              name: { S: link.name },
              messageTs: { N: String(link.messageTs) },
            },
            ConditionExpression: 'attribute_not_exists(#pk) OR #ts <= :ts',
            ExpressionAttributeNames: { '#pk': 'pk', '#ts': 'messageTs' },
            ExpressionAttributeValues: { ':ts': { N: String(link.messageTs) } },
          }),
        );
      } catch (error) {
        // A later share already linked this sender: that one stands.
        if (error instanceof ConditionalCheckFailedException) return;
        throw error;
      }
    },
    async get(group, sender) {
      const response = await client.send(
        new GetItemCommand({ TableName: tableName, Key: { pk: { S: partition(group) }, sk: { S: sender } } }),
      );
      return response.Item ? fromItem(response.Item) : null;
    },
    async list(group) {
      const links: PlayerLink[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const response = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: partition(group) } },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        for (const item of response.Items ?? []) links.push(fromItem(item));
        cursor = response.LastEvaluatedKey;
      } while (cursor);
      return links;
    },
    async delete(group, sender) {
      await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: partition(group) }, sk: { S: sender } } }));
    },
  };
}

export function memoryPlayerIdStore(): PlayerIdStore {
  const rows = new Map<string, PlayerLink>();
  return {
    async put(group, link) {
      const key = `${group}#${link.sender}`;
      const standing = rows.get(key);
      if (standing && standing.messageTs > link.messageTs) return;
      rows.set(key, { ...link });
    },
    async get(group, sender) {
      return rows.get(`${group}#${sender}`) ?? null;
    },
    async list(group) {
      return [...rows.entries()].filter(([k]) => k.startsWith(`${group}#`)).map(([, v]) => v);
    },
    async delete(group, sender) {
      rows.delete(`${group}#${sender}`);
    },
  };
}

// publicId → the sender's WhatsApp name, as the group sees it (`names.ts`), the latest link
// winning when two senders claimed one account.
export function whatsappNames(group: GroupConfig, links: readonly PlayerLink[]): Map<string, string> {
  const latest = new Map<string, PlayerLink>();
  for (const link of links) {
    const standing = latest.get(link.publicId);
    if (!standing || standing.messageTs < link.messageTs) latest.set(link.publicId, link);
  }
  return new Map([...latest].map(([id, link]) => [id, displayName(group, link.sender, link.name)]));
}
