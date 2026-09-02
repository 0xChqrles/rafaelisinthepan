import { describe, expect, it, vi } from 'vitest';
import { GetParametersCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { loadConfig, loadScoreSecrets } from './config';

const ENV: NodeJS.ProcessEnv = {
  PUZZLE_BUCKET: 'puzzles',
  SCORE_TABLE: 'scores',
  TURNSTILE_SECRET_PARAMETER: '/whippin/turnstile-secret',
  IP_HMAC_SECRET_PARAMETER: '/whippin/ip-hmac-secret',
  // The verified SES sender the #204 link codes go out as — required, like the table name.
  MAIL_FROM: 'Whippin <hello@whippin.ai>',
  ALLOWED_ORIGIN: 'https://whippin.ai',
};

describe('production score-secret configuration', () => {
  it('accepts only parameter names in the Lambda environment', () => {
    expect(loadConfig(ENV)).toMatchObject({
      turnstileSecretParameter: '/whippin/turnstile-secret',
      ipHmacSecretParameter: '/whippin/ip-hmac-secret',
    });
    expect(() =>
      loadConfig({
        PUZZLE_BUCKET: 'puzzles',
        SCORE_TABLE: 'scores',
        TURNSTILE_SECRET: 'plaintext-is-not-a-supported-env-contract',
        IP_HMAC_SECRET: 'plaintext-is-not-a-supported-env-contract',
      }),
    ).toThrow(/TURNSTILE_SECRET_PARAMETER/);
  });

  it('loads both encrypted values with one GetParameters call', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetParametersCommand);
      return {
        // Deliberately reversed: values are matched by name, never response position.
        Parameters: [
          { Name: '/whippin/ip-hmac-secret', Type: 'SecureString', Value: 'h'.repeat(32) },
          {
            Name: '/whippin/turnstile-secret',
            Type: 'SecureString',
            Value: 'turnstile-value',
          },
        ],
      };
    });

    await expect(
      loadScoreSecrets({ send } as unknown as SSMClient, loadConfig(ENV)),
    ).resolves.toEqual({
      turnstileSecret: 'turnstile-value',
      ipHmacSecret: 'h'.repeat(32),
    });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0][0] as GetParametersCommand).input;
    expect(input).toEqual({
      Names: ['/whippin/turnstile-secret', '/whippin/ip-hmac-secret'],
      WithDecryption: true,
    });
  });

  it('fails closed when a parameter is missing or the HMAC key is too short', async () => {
    const missing = vi.fn(async () => ({
      Parameters: [
        {
          Name: '/whippin/turnstile-secret',
          Type: 'SecureString',
          Value: 'turnstile-value',
        },
      ],
      InvalidParameters: ['/whippin/ip-hmac-secret'],
    }));
    await expect(
      loadScoreSecrets({ send: missing } as unknown as SSMClient, loadConfig(ENV)),
    ).rejects.toThrow(/ip-hmac-secret/);

    const short = vi.fn(async () => ({
      Parameters: [
        {
          Name: '/whippin/turnstile-secret',
          Type: 'SecureString',
          Value: 'turnstile-value',
        },
        { Name: '/whippin/ip-hmac-secret', Type: 'SecureString', Value: 'short' },
      ],
    }));
    await expect(
      loadScoreSecrets({ send: short } as unknown as SSMClient, loadConfig(ENV)),
    ).rejects.toThrow(/at least 32 bytes/);
  });

  it('rejects an accidentally plaintext SSM parameter', async () => {
    const plaintext = vi.fn(async () => ({
      Parameters: [
        { Name: '/whippin/turnstile-secret', Type: 'String', Value: 'turnstile-value' },
        { Name: '/whippin/ip-hmac-secret', Type: 'SecureString', Value: 'h'.repeat(32) },
      ],
    }));
    await expect(
      loadScoreSecrets({ send: plaintext } as unknown as SSMClient, loadConfig(ENV)),
    ).rejects.toThrow(/SecureString.*turnstile-secret/);
  });
});
