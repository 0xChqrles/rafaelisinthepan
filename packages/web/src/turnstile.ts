// Invisible Cloudflare Turnstile (#170): the ONLY module that knows Turnstile exists —
// the analytics.ts pattern. A score submission (#169) needs one fresh token, verified
// server-side; the widget is the invisible kind, so there is nothing to render and
// nothing the player ever sees. The script loads lazily, on the first solve that needs a
// token — never at startup — and every failure REJECTS quietly: the caller degrades to
// "no histogram", never to an error in the player's face.
//
// **The site key MUST be provisioned as an INVISIBLE widget** — Cloudflare's default is
// "Managed", which is not a stricter version of the same thing but a different widget: it
// may escalate to an interactive challenge, and this one renders into a `display: none`
// container with no path to the screen. That challenge would then sit unclickable until
// the token times out, silently dropping the score of exactly the players Cloudflare
// doubts, on every visit. Nothing in code can detect the widget type, so it is stated
// here and beside the key in `.env.example` / the deploy docs.

interface TurnstileApi {
  render: (
    container: HTMLElement,
    params: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback': () => boolean;
      action?: string;
    },
  ) => string | undefined;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// A request that neither loads nor errors must not strand the cached promise forever.
const SCRIPT_TIMEOUT_MS = 20_000;
// A challenge that has not produced a token by then never will (the widget retries
// internally); reject so the caller can give up silently.
const TOKEN_TIMEOUT_MS = 20_000;

export function turnstileSiteKey(env: ImportMetaEnv = import.meta.env): string {
  return env.VITE_TURNSTILE_SITE_KEY ?? '';
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    // EVERY failed load clears the cached promise, not just the network one: a rejected
    // promise left in `scriptPromise` disables score submission for the whole SESSION,
    // since every later call short-circuits on the cache instead of trying a fresh load.
    // The `window.turnstile` fast path above rescues only an API that defines LATE, never
    // one that never defines at all.
    //
    // This attempt settles ONCE. An aborted request can still deliver its error event after
    // the timeout has already given up on it, and by then `scriptPromise` may hold a fresh
    // attempt's promise — which a second `fail` would null out from under it. Nothing
    // visible goes wrong today (the next call just builds a redundant script, and the
    // window.turnstile fast path usually swallows even that), but the rule is what makes it
    // safe to add state to these paths later.
    let settled = false;
    let timeout: number;
    const done = () => {
      settled = true;
      window.clearTimeout(timeout);
    };
    const fail = (message: string) => {
      if (settled) return;
      done();
      scriptPromise = null;
      script.remove();
      reject(new Error(message));
    };
    script.onload = () => {
      if (window.turnstile) {
        if (settled) return;
        done();
        resolve(window.turnstile);
      }
      // A 200 that carried no API: a truncated response, or a privacy extension serving a
      // stub. A later solve may well get the real thing.
      else fail('Turnstile script loaded without its API.');
    };
    // A blocked script (offline, content blocker) must be retryable on a later solve.
    script.onerror = () => fail('Turnstile script failed to load.');
    timeout = window.setTimeout(
      () => fail('Turnstile script timed out.'),
      SCRIPT_TIMEOUT_MS,
    );
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// One fresh token for one submission. Rejects when unconfigured, blocked, errored or
// timed out — the caller treats every rejection the same way (no submission, no message).
export async function turnstileToken(siteKey: string = turnstileSiteKey()): Promise<string> {
  if (!siteKey) throw new Error('VITE_TURNSTILE_SITE_KEY is not set.');
  const turnstile = await loadTurnstile();
  // The invisible widget still wants a container; it never paints into it.
  const container = document.createElement('div');
  container.style.display = 'none';
  document.body.appendChild(container);
  let widgetId: string | undefined;
  const cleanup = () => {
    try {
      if (widgetId !== undefined) turnstile.remove(widgetId);
    } finally {
      container.remove();
    }
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('Turnstile token timed out.')),
        TOKEN_TIMEOUT_MS,
      );
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        callback: (token) => {
          window.clearTimeout(timeout);
          resolve(token);
        },
        'error-callback': () => {
          window.clearTimeout(timeout);
          reject(new Error('Turnstile challenge errored.'));
          // Tell the widget the error is handled — no visible fallback message.
          return true;
        },
      });
      if (widgetId === undefined) {
        window.clearTimeout(timeout);
        reject(new Error('Turnstile widget failed to render.'));
      }
    });
  } finally {
    cleanup();
  }
}
