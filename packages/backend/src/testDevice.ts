// TEST-ONLY fixture: one device and the account it acts as (#216).
//
// Every route test used to be able to spell an identity inline — a secret was a literal,
// and the publicId was a pure function of it. Since #216 an identity is a STORED pair, so a
// test that wants an authenticated caller has to seed one. This is that one line, in one
// place, so the tests describe what they are testing rather than how a device is created.
//
// Nothing in the Lambda's import graph reaches this file; it is not bundled.

import { generateDeviceId, generateDeviceToken, generatePublicId } from '@whippin/shared';
import { deviceTokenHash, type BootstrapInput, type DeviceStore } from './deviceStore';

export interface TestDevice {
  // What the client sends: the raw token, never stored anywhere.
  token: string;
  // What the server assigns, and what every stored row is keyed by.
  accountId: string;
  deviceId: string;
}

// A device that does not exist yet. Synchronous, so a test can name its caller at module
// level and hand the seed to `memoryDeviceStore` when it builds one.
export function newTestDevice(accountId: string = generatePublicId()): TestDevice {
  return { token: generateDeviceToken(), accountId, deviceId: generateDeviceId() };
}

export function deviceSeed(device: TestDevice, now = '2026-01-01T00:00:00.000Z'): BootstrapInput {
  return {
    tokenHash: deviceTokenHash(device.token),
    accountId: device.accountId,
    deviceId: device.deviceId,
    agent: { device: 'Test', os: 'Test', browser: 'Test' },
    now,
  };
}

// Mint a device and put it in the store, for the tests whose setup is already async.
export async function seedDevice(
  devices: DeviceStore,
  options: { accountId?: string; now?: string } = {},
): Promise<TestDevice> {
  // An explicit account id is for the tests that need TWO devices on ONE account.
  const device = newTestDevice(options.accountId);
  await devices.bootstrap(deviceSeed(device, options.now));
  return device;
}
