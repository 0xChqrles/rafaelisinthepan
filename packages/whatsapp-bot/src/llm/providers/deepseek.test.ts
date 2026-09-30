import { describe, expect, it, vi } from 'vitest';
import { LlmUnavailable } from '../types';
import { deepSeekProvider } from './deepseek';

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('DeepSeek provider boundary (#236)', () => {
  it('maps the neutral request onto the wire format and the answer back', async () => {
    const doFetch = fetchReturning(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c1', function: { name: 'get_today_podium', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    const provider = deepSeekProvider({ apiKey: 'k', model: 'deepseek-flash', fetch: doFetch });
    const response = await provider.generate({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 't', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'x', content: '{}' },
      ],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
      maxTokens: 50,
    });
    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'get_today_podium', arguments: '{}' }]);
    expect(response.finish).toBe('tool_calls');
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    const [url, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe('deepseek-flash');
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[2].tool_calls[0].function.name).toBe('t');
    expect(sent.messages[3]).toEqual({ role: 'tool', content: '{}', tool_call_id: 'x' });
    expect(sent.tools[0].function.name).toBe('t');
    expect(sent.max_tokens).toBe(50);
  });

  it('maps `effort` onto DeepSeek\'s thinking controls, and sends nothing when absent', async () => {
    // `none` is the thinking switch, off; `low`/`high` are `reasoning_effort` (the docs'
    // own names). No effort = the provider's default, which is thinking on at high.
    for (const [effort, expected] of [
      ['none', { thinking: { type: 'disabled' } }],
      ['low', { reasoning_effort: 'low' }],
      ['high', { reasoning_effort: 'high' }],
      [undefined, {}],
    ] as const) {
      const doFetch = fetchReturning(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
      const provider = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: doFetch });
      await provider.generate({ system: '', messages: [], maxTokens: 1, effort });
      const sent = JSON.parse(((doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
      const { model: _m, messages: _ms, max_tokens: _t, temperature: _p, ...rest } = sent;
      expect(rest).toEqual(expected);
    }
  });

  it('reads outages as LlmUnavailable and a 4xx as a bug', async () => {
    const down = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: fetchReturning(503, {}) });
    await expect(down.generate({ system: '', messages: [], maxTokens: 1 })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    const bad = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: fetchReturning(401, {}) });
    await expect(bad.generate({ system: '', messages: [], maxTokens: 1 })).rejects.toThrow(
      'HTTP 401',
    );

    // A request that never came back — what `AbortSignal.timeout` rejects the fetch with —
    // is an outage, and names its cause.
    const timeout = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const hung = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: timeout });
    const failure = await hung.generate({ system: '', messages: [], maxTokens: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmUnavailable);
    expect((failure as Error).message).toBe('deepseek: TimeoutError: The operation was aborted due to timeout');

    // A rate limit is the one 4xx that is weather and not a bug.
    const limited = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: fetchReturning(429, {}) });
    const refused = await limited.generate({ system: '', messages: [], maxTokens: 1 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LlmUnavailable);
    expect((refused as Error).message).toBe('deepseek: HTTP 429');

    // And so is a 200 whose body is not the JSON it promised.
    const notJson = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 200 })) as unknown as typeof fetch;
    const garbled = deepSeekProvider({ apiKey: 'k', model: 'm', fetch: notJson });
    const unread = await garbled.generate({ system: '', messages: [], maxTokens: 1 }).catch((error: unknown) => error);
    expect(unread).toBeInstanceOf(LlmUnavailable);
    expect((unread as Error).message).toBe('deepseek: unparseable body');
  });
});
