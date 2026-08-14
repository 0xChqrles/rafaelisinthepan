export interface TurnstileVerifier {
  verify(token: string, remoteIp: string): Promise<boolean>;
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5_000;

interface SiteverifyResponse {
  success?: boolean;
}

// Cloudflare tokens are one-use and expire after five minutes. Siteverify is the one
// authoritative check; no client-side widget result is trusted by the backend.
export function turnstileVerifier(
  secret: string,
  fetcher: typeof fetch = fetch,
): TurnstileVerifier {
  return {
    async verify(token, remoteIp) {
      const response = await fetcher(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Turnstile siteverify returned HTTP ${response.status}.`);
      }
      const result = (await response.json()) as SiteverifyResponse;
      return result.success === true;
    },
  };
}

// Used only by the local server wiring. Body/token shape is still validated by the same
// handler, but no network call or Cloudflare credential is needed on a laptop.
export const localTurnstileVerifier: TurnstileVerifier = {
  async verify() {
    return true;
  },
};
