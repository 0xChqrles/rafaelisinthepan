// Invisible Cloudflare Turnstile (#170): the ONLY module that knows Turnstile exists —
// the analytics.ts pattern. A score submission (#169) needs one fresh token, verified
// server-side; the widget is the invisible kind, so there is nothing to render and
// nothing the player ever sees. The script loads lazily, on the first solve that needs a
// token — never at startup — and every failure REJECTS quietly: the caller degrades to
// "no histogram", never to an error in the player's face.

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
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('Turnstile script loaded without its API.'));
    };
    script.onerror = () => {
      // A blocked script (offline, content blocker) must be retryable on a later solve.
      scriptPromise = null;
      script.remove();
      reject(new Error('Turnstile script failed to load.'));
    };
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
