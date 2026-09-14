// THE PREVIEW CARD, WAITED FOR (user-decided 2026-09-14). WhatsApp does not unfurl a link
// for the people who receive it: the SENDER's client fetches the page and embeds the card
// in the message itself — which is what a person does by waiting for the preview to appear
// before tapping send. Baileys does the same with `getUrlInfo`, over its optional peer
// `link-preview-js`; given `uploadImage` it sends the page's image up as a full-size card
// rather than a thumbnail.
//
// ONLY FOR THE LINK A COMMAND NAMES (`OutboundCommand.preview`). Every other send passes
// `linkPreview: null` (`client.ts`), because left undefined Baileys fetches the first https
// link in ANY text — a model's reply or a member's words passed on — from inside the task.
//
// BOUNDED AS A WHOLE. The image download inside `getUrlInfo` has no timeout of its own, and
// this runs inside the ONE outbound loop, where a hung card would hold every message queued
// behind it. So the build gets `PREVIEW_BUDGET_MS`, and a card that does not arrive in time
// — or at all — costs the card, never the message.

import { getUrlInfo, type URLGenerationOptions, type WAUrlInfo } from 'baileys';
import type { Log } from '../log';

// The page fetch (link-preview-js) and the image download each get this much. The card is
// rendered on a cache miss, measured at 2.3s — against the 3s Baileys defaults to.
const FETCH_TIMEOUT_MS = 10_000;
// The whole build, the upload included: well inside the queue's 60s visibility timeout.
export const PREVIEW_BUDGET_MS = 20_000;
// Baileys' own default for the small inline thumbnail.
const THUMBNAIL_WIDTH_PX = 192;

export interface LinkPreviewDeps {
  upload: NonNullable<URLGenerationOptions['uploadImage']>;
  log: Log;
  logger?: URLGenerationOptions['logger'];
  budgetMs?: number;
  // The builder, injectable for tests; Baileys' own otherwise.
  build?: typeof getUrlInfo;
}

// An error's words without the link it may quote: an invite link is a way into a group.
const withoutUrls = (message: string) => message.replace(/https?:\/\/\S+/g, '<url>');

export async function buildLinkPreview(url: string, deps: LinkPreviewDeps): Promise<WAUrlInfo | null> {
  const build = deps.build ?? getUrlInfo;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), deps.budgetMs ?? PREVIEW_BUDGET_MS);
  });
  try {
    // A build still running when the budget ends is left to finish on its own: the race
    // holds its rejection, so a late failure is not an unhandled one.
    const info = await Promise.race([
      build(url, {
        thumbnailWidth: THUMBNAIL_WIDTH_PX,
        fetchOpts: { timeout: FETCH_TIMEOUT_MS },
        uploadImage: deps.upload,
        logger: deps.logger,
      }),
      expired,
    ]);
    const latencyMs = Date.now() - started;
    if (info === 'expired') {
      deps.log.warn({ event: 'outbound.preview_timeout', latencyMs }, 'sending without the link preview');
      return null;
    }
    if (!info) {
      // The page answered without a title: there is nothing to put on a card.
      deps.log.warn({ event: 'outbound.preview_empty', latencyMs }, 'sending without the link preview');
      return null;
    }
    deps.log.info({ event: 'outbound.preview_built', latencyMs, card: Boolean(info.highQualityThumbnail) }, 'link preview built');
    return info;
  } catch (error) {
    deps.log.warn(
      { event: 'outbound.preview_failed', error: withoutUrls((error as Error).message) },
      'sending without the link preview',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
