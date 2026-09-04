// The group-config STORE: SSM Parameter Store, one `String` parameter per group at
// `/whippin/bot/groups/<slug>` (#236).
//
// WHY NOT THE REPOSITORY. A group JID names a real private conversation and this repo is
// public, so the configs cannot be committed. They are not secrets either — a config holds
// product behaviour and nothing else — so this is a plain `String` parameter, protected by
// IAM like everything else in the account, not a SecureString pretending to hold a
// credential.
//
// SSM IS REGIONAL, AND THE WRONG REGION FAILS SILENTLY: `GetParametersByPath` against a
// path that does not exist there answers an EMPTY LIST, not an error. So a laptop whose
// ambient region is not the deployment's would read nothing, write somewhere `deploy-bot`
// never looks, and report success — the snapshot would ship without what was just edited.
// The region is therefore PINNED here rather than inherited (`GROUPS_REGION`): the stacks
// are pinned to us-east-1 in `infra/bin/app.ts`, so that is where these parameters are,
// and it is not a fact a shell variable should be able to get wrong. `BOT_AWS_REGION`
// overrides it for a deployment that moves.
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
import { BOT_REGION } from './env';
import { GroupConfigError, assertUniqueGroupIds, parseGroupConfig, type GroupConfig } from './groupConfig';

export const GROUPS_PATH = '/whippin/bot/groups';

// Where the stacks are — the package's one region (`config/env.ts` says why it is pinned).
export const GROUPS_REGION = BOT_REGION;

// SSM's Standard tier caps a parameter value at 4 KB. The Advanced tier is a per-parameter
// monthly charge and a different API, for a value that is one group's settings: a config
// that does not fit is a `chat.prePrompt` that wants trimming, said at the moment it is
// written rather than discovered by a failing deploy.
export const MAX_VALUE_BYTES = 4096;

// A slug names a parameter AND a file, so it may contain nothing that could reach out of
// either — no dots, no slashes, no spaces.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const isSlug = (name: string): boolean => SLUG.test(name);

export function assertSlug(slug: string): void {
  if (!isSlug(slug)) {
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

// A parameter under the path that is NOT a usable group: a name that is no slug (made by
// hand in the console — `Main`, `main.fr`), or a body the parser refuses (hand-edited, or
// written before a rule the parser has since gained). It is REPORTED, never silently
// skipped — somebody put it there meaning it to be a group — and never fatal to a read.
export interface BrokenParameter {
  name: string; // the child name under GROUPS_PATH, exactly as SSM holds it
  json: string;
  reason: string;
}

// What the path holds, sorted, with the unusable ones set apart. A read does NOT throw on
// a broken parameter and does NOT judge the set (duplicate JIDs): it is the read behind
// `edit` and `rm`, which are how a broken parameter gets FIXED, and a read that refused it
// would lock the operator out of every command at once, the console being the only way
// back in. `assertDeployable` judges the set, and `pull` — the deploy's door — is the one
// command that asks.
export interface GroupsListing {
  groups: StoredGroup[];
  broken: BrokenParameter[];
}

const childName = (parameter: Parameter): string => (parameter.Name ?? '').slice(GROUPS_PATH.length + 1);

// Parse + validate one stored value under the SAME parser the bot and the stack use. The
// name becomes a FILENAME in the snapshot, so it is checked coming OUT of the store as
// well as going in — this module owns that rule, and never trusts a name it read.
function toStored(name: string, json: string): StoredGroup {
  assertSlug(name);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new GroupConfigError(`${name}: invalid JSON in SSM (${(error as Error).message})`);
  }
  return { slug: name, json, config: parseGroupConfig(name, raw) };
}

// A parameter whose name is no slug cannot be named by `rm` — a slug is what `rm` accepts,
// and that rule is not loosened for the one case — so it is removed where it was made.
export const removeByHand = (name: string): string =>
  `aws ssm delete-parameter --region ${GROUPS_REGION} --name "${GROUPS_PATH}/${name}"`;

// What a SNAPSHOT may be built from: every parameter usable, and the set valid as a set.
// The message names sources and reasons, never a JID (it reaches CI logs).
export function assertDeployable(listing: GroupsListing): void {
  if (listing.broken.length > 0) {
    const lines = listing.broken.map((b) => `  ${b.name}: ${b.reason}`).join('\n');
    throw new GroupConfigError(
      `${listing.broken.length} parameter(s) under ${GROUPS_PATH} cannot be deployed:\n${lines}\nSee \`pnpm bot:groups list\` for the way out of each.`,
    );
  }
  assertUniqueGroupIds(listing.groups.map((g) => ({ id: g.config.id, source: g.slug })));
}

export interface GroupsStore {
  list(): Promise<GroupsListing>;
  put(slug: string, json: string): Promise<void>;
  remove(slug: string): Promise<boolean>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function ssmGroupsStore(client: SSMClient): GroupsStore {
  return {
    async list() {
      const groups: StoredGroup[] = [];
      const broken: BrokenParameter[] = [];
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
          const name = childName(parameter);
          if (name === '' || parameter.Value === undefined) continue;
          try {
            groups.push(toStored(name, parameter.Value));
          } catch (error) {
            if (!(error instanceof GroupConfigError)) throw error;
            broken.push({ name, json: parameter.Value, reason: error.message });
          }
        }
        token = response.NextToken;
      } while (token);
      // Byte order, not locale order: the list must read the same on an operator laptop
      // and the CI runner.
      groups.sort((a, b) => compare(a.slug, b.slug));
      broken.sort((a, b) => compare(a.name, b.name));
      return { groups, broken };
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
