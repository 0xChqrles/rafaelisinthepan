// SOCIAL MEMORY (#236): durable, compact, keyed by (group, JID) — the same phone number in
// another group inherits nothing. It is a bounded list of short facts, each written from a
// direct interaction (a player telling the bot something about themselves) or a structured
// statistic; never a summary of the group's chatter, and never a sensitive attribute
// inferred from it. The record carries a version and `updatedAt`, and a fact list that is
// REPLACED at the bound rather than appended to forever. `forget` removes one JID's
// conversational memory without touching their scoreboard rows, which live elsewhere.

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';

export const MEMORY_VERSION = 1;
export const MEMORY_MAX_FACTS = 8;
export const MEMORY_FACT_MAX_CHARS = 120;

export interface PlayerMemory {
  version: number;
  updatedAt: string;
  facts: string[];
}

export interface MemoryStore {
  get(group: string, jid: string): Promise<PlayerMemory | null>;
  put(group: string, jid: string, memory: PlayerMemory): Promise<void>;
  forget(group: string, jid: string): Promise<void>;
}

export function memoryKey(group: string, jid: string) {
  return { pk: { S: `MEMORY#${group}` }, sk: { S: `PLAYER#${jid}` } };
}

// A fact is one short plain-text line; the newest facts win the bound.
export function withFact(memory: PlayerMemory | null, fact: string, now: Date): PlayerMemory | null {
  const clean = fact.replace(/\s+/g, ' ').trim();
  if (clean === '' || clean.length > MEMORY_FACT_MAX_CHARS) return null;
  const facts = (memory?.facts ?? []).filter((f) => f !== clean);
  facts.push(clean);
  return {
    version: MEMORY_VERSION,
    updatedAt: now.toISOString(),
    facts: facts.slice(-MEMORY_MAX_FACTS),
  };
}

export function dynamoMemoryStore(client: DynamoDBClient, tableName: string): MemoryStore {
  return {
    async get(group, jid) {
      const item = (
        await client.send(new GetItemCommand({ TableName: tableName, Key: memoryKey(group, jid) }))
      ).Item;
      if (!item) return null;
      return {
        version: Number(item.version?.N ?? MEMORY_VERSION),
        updatedAt: item.updatedAt?.S ?? '',
        facts: (item.facts?.L ?? []).flatMap((f) => (f.S ? [f.S] : [])),
      };
    },
    async put(group, jid, memory) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            ...memoryKey(group, jid),
            version: { N: String(memory.version) },
            updatedAt: { S: memory.updatedAt },
            facts: { L: memory.facts.map((f) => ({ S: f })) },
          },
        }),
      );
    },
    async forget(group, jid) {
      await client.send(new DeleteItemCommand({ TableName: tableName, Key: memoryKey(group, jid) }));
    },
  };
}

export function memoryMemoryStore(): MemoryStore {
  const rows = new Map<string, PlayerMemory>();
  return {
    async get(group, jid) {
      return rows.get(`${group}#${jid}`) ?? null;
    },
    async put(group, jid, memory) {
      rows.set(`${group}#${jid}`, memory);
    },
    async forget(group, jid) {
      rows.delete(`${group}#${jid}`);
    },
  };
}
