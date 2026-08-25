// ONE spelling of the sign-out RESOLUTION every private caller shares (#216): read the
// refusal's CODE and adopt the verdict only for `unknown_device` (`isUnknownDeviceAnswer`,
// api.ts) — a refusal with no readable body says nothing about the device, and a 5xx or a
// dropped connection must never sign anyone out at all. It was spelled inline by every
// route client (nine copies across six files by the PR-219 review), which is exactly the
// drift one helper exists to prevent.
//
// Returns whether the verdict applied; `markDeviceSignedOut`'s own epoch fence still
// governs it. Callers that already parsed the body for other codes use the predicate
// directly instead — a body can only be read once.

import { isUnknownDeviceAnswer } from '../api';
import { markDeviceSignedOut } from '../identity';

export async function adoptSignedOutVerdict(
  response: { status: number; json(): Promise<unknown> },
  epoch: string,
): Promise<boolean> {
  if (response.status !== 401) return false;
  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    return false;
  }
  if (!isUnknownDeviceAnswer(response.status, error)) return false;
  markDeviceSignedOut(epoch);
  return true;
}
