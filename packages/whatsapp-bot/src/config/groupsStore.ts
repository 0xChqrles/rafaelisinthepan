// The group-config STORE: SSM Parameter Store, one `String` parameter per group at
// `/whippin/bot/groups/<slug>` (#236).
//
// WHY NOT THE REPOSITORY. A group JID names a real private conversation and this repo is
// public, so the configs cannot be committed. They are not secrets either — a config holds
// product behaviour and nothing else — so this is a plain `String` parameter, protected by
// IAM like everything else in the account, not a SecureString pretending to hold a
// credential.
//
// WHY A SNAPSHOT RATHER THAN A RUNTIME READ. Neither the task nor the podium Lambda talks
// to this module: they read files, and those files are pulled from here immediately before
// a build or a deploy. So one deployment runs on ONE coherent set, a group cannot change
// under a running task, and SSM being slow or unreachable can never be a reason the bot
// stops recognising a group. The trade is deliberate and is the whole shape of the design:
// **editing SSM does not change production — a deploy promotes it.**

import {
  DeleteParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  ParameterType,
  PutParameterCommand,
  SSMClient,
  type Parameter,
} from '@aws-sdk/client-ssm';
import { GroupConfigError, assertUniqueGroupIds, parseGroupConfig, type GroupConfig } from './groupConfig';

export const GROUPS_PATH = '/whippin/bot/groups';

// SSM's Standard tier caps a parameter value at 4 KB. The Advanced tier is a per-parameter
// monthly charge and a different API, for a value that is one group's settings: a config
// that does not fit is a `chat.prePrompt` that wants trimming, said at the moment it is
// written rather than discovered by a failing deploy.
export const MAX_VALUE_BYTES = 4096;

// A slug names a parameter AND a file, so it may contain nothing that could reach out of
// either — no dots, no slashes, no spaces.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function assertSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new GroupConfigError(
      `"${slug}" is not a valid slug: lowercase letters, digits and dashes, starting with a letter or digit.`,
    );
  }
}

export const parameterName = (slug: string): string => {
  assertSlug(slug);
  return `${GROUPS_PATH}/${slug}`;
};

export interface StoredGroup {
  slug: string;
  json: string; // exactly what SSM holds, so a pull writes what an edit wrote
  config: GroupConfig;
}

const slugOf = (parameter: Parameter): string => (parameter.Name ?? '').slice(GROUPS_PATH.length + 1);

// Parse + validate one stored value under the SAME parser the bot and the stack use. A
// config that does not parse is an error wherever it is met — reading it is not the place
// to start being lenient, since the next reader is a deploy.
function toStored(slug: string, json: string): StoredGroup {
  // The slug becomes a FILENAME in the snapshot, so it is checked coming OUT of the store
  // as well as going in — this module owns that rule, and never trusts a name it read.
  assertSlug(slug);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new GroupConfigError(`${slug}: invalid JSON in SSM (${(error as Error).message})`);
  }
  return { slug, json, config: parseGroupConfig(slug, raw) };
}

export interface GroupsStore {
  list(): Promise<StoredGroup[]>;
  get(slug: string): Promise<StoredGroup | null>;
  put(slug: string, json: string): Promise<void>;
  remove(slug: string): Promise<boolean>;
}

export function ssmGroupsStore(client: SSMClient): GroupsStore {
  return {
    async list() {
      const found: StoredGroup[] = [];
      let token: string | undefined;
      do {
        const response = await client.send(
          new GetParametersByPathCommand({
            Path: GROUPS_PATH,
            Recursive: false,
            MaxResults: 10,
            ...(token ? { NextToken: token } : {}),
          }),
        );
        for (const parameter of response.Parameters ?? []) {
          const slug = slugOf(parameter);
          if (slug === '' || parameter.Value === undefined) continue;
          found.push(toStored(slug, parameter.Value));
        }
        token = response.NextToken;
      } while (token);
      found.sort((a, b) => a.slug.localeCompare(b.slug));
      // The set is only valid as a SET: one JID may not be configured twice.
      assertUniqueGroupIds(found.map((g) => ({ id: g.config.id, source: g.slug })));
      return found;
    },

    async get(slug) {
      // Read through the LIST rather than GetParameter: the same one call answers "does it
      // exist" and "what else is configured", which is what an edit has to check anyway.
      const all = await this.list();
      return all.find((g) => g.slug === slug) ?? null;
    },

    async put(slug, json) {
      await client.send(
        new PutParameterCommand({
          Name: parameterName(slug),
          Value: json,
          Type: ParameterType.STRING,
          Overwrite: true,
          Description: 'Whippin WhatsApp bot: one group configuration (#236)',
        }),
      );
    },

    async remove(slug) {
      try {
        await client.send(new DeleteParameterCommand({ Name: parameterName(slug) }));
        return true;
      } catch (error) {
        if (error instanceof ParameterNotFound) return false;
        throw error;
      }
    },
  };
}

// What `edit` enforces before anything reaches SSM. Returns the canonical text to store:
// pretty-printed, so the next `edit` opens something a human can read and a diff is legible.
export function validateForStore(
  slug: string,
  json: string,
  others: readonly StoredGroup[],
): string {
  assertSlug(slug);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new GroupConfigError(`invalid JSON (${(error as Error).message})`);
  }
  const config = parseGroupConfig(slug, raw);
  assertUniqueGroupIds([
    ...others.filter((o) => o.slug !== slug).map((o) => ({ id: o.config.id, source: o.slug })),
    { id: config.id, source: slug },
  ]);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_VALUE_BYTES) {
    throw new GroupConfigError(
      `config is ${bytes} bytes, over SSM Standard's ${MAX_VALUE_BYTES}; shorten chat.prePrompt.`,
    );
  }
  return text;
}
