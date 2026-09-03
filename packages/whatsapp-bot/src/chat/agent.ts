// The addressed-conversation agent (#236). Runs ONLY for a message the trigger policy
// admitted (chat/trigger.ts), inside the ceilings (chat/limits.ts): builds the prompt —
// global personality + group pre-prompt + the sender's compact memory + recent context —
// lets the model call the allow-listed tools a bounded number of rounds, and returns one
// short plain-text reply. The model writes comments, never facts: every number it says
// came back from a tool. An unavailable model means no answer (and a log line), never a
// crash of the transport that carries the scoreboard.

import { dateForDayNumber } from '@whippin/shared';
import type { GroupConfig } from '../config/groupConfig';
import type { DeclarationStore } from '../domain/declarations';
import type { InboundMessage } from '../domain/message';
import { displayName } from '../domain/names';
import { buildSystemPrompt } from '../llm/personality';
import { LlmUnavailable, type LlmMessage, type LlmProvider } from '../llm/types';
import type { Log } from '../log';
import { tag } from '../log';
import type { RecentContext } from './context';
import { limitExpiry, limitKeys, type LimitStore } from './limits';
import type { MemoryStore } from './memory';
import { createToolRunner } from './tools';
import { questionText, type BotIdentity } from './trigger';

export const MAX_TOOL_ROUNDS = 4;
export const REPLY_MAX_CHARS = 700;
const REPLY_MAX_TOKENS = 300;

export interface AgentDeps {
  provider: LlmProvider;
  declarations: DeclarationStore;
  memory: MemoryStore;
  limits: LimitStore;
  context: RecentContext;
  dailyCallCeiling: number;
  log: Log;
  now?: () => Date;
}

export type AgentOutcome =
  | { kind: 'reply'; text: string }
  | {
      kind: 'silent';
      reason: 'user_limit' | 'group_limit' | 'call_ceiling' | 'unavailable' | 'empty';
    };

// One plain-text bubble: markdown marks and control characters out, whitespace collapsed,
// bounded length (a cut at a sentence end where one exists).
export function plainReply(raw: string | null): string | null {
  if (!raw) return null;
  let text = raw
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[*_~`#]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length > REPLY_MAX_CHARS) {
    const cut = text.slice(0, REPLY_MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = (end > REPLY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim();
  }
  return text === '' ? null : text;
}

export function createAgent(deps: AgentDeps) {
  const now = deps.now ?? (() => new Date());

  async function takeCall(): Promise<boolean> {
    const at = now();
    const { scope, key } = limitKeys.calls(at);
    return deps.limits.take(scope, key, deps.dailyCallCeiling, limitExpiry(at));
  }

  return async function answer(
    message: InboundMessage,
    group: GroupConfig,
    identity: BotIdentity,
    today: number,
  ): Promise<AgentOutcome> {
    const at = now();
    // A BARE MENTION IS NOT A QUESTION, and it costs nothing. The ceilings bound
    // CONVERSATIONS; charging one before there is anything to answer lets a tap of the
    // bot's name — an autocomplete, a mention in passing, a reply carrying only a sticker
    // — burn a group's whole day of replies without a single model call ever being made.
    const question = questionText(message, identity);
    if (question === '') return { kind: 'silent', reason: 'empty' };

    const user = limitKeys.user(group.id, message.sender, at);
    if (!(await deps.limits.take(user.scope, user.key, group.chat.perUserPerDay, limitExpiry(at)))) {
      return { kind: 'silent', reason: 'user_limit' };
    }
    const g = limitKeys.group(group.id, at);
    if (!(await deps.limits.take(g.scope, g.key, group.chat.perGroupPerDay, limitExpiry(at)))) {
      return { kind: 'silent', reason: 'group_limit' };
    }

    const senderName = displayName(group, message.sender, message.senderName);
    const memory = await deps.memory.get(group.id, message.sender);

    const tools = createToolRunner({
      group,
      today,
      sender: message.sender,
      declarations: deps.declarations,
      memory: deps.memory,
      now,
    });
    const notes =
      memory && memory.facts.length > 0
        ? `Your notes about ${senderName} (things they told you):\n- ${memory.facts.join('\n- ')}`
        : '';
    const system = buildSystemPrompt({
      language: group.language,
      groupPrePrompt: group.chat.prePrompt,
      extra: [
        `Today's Whippin day is ${dateForDayNumber(today)}. You are talking to ${senderName}. Use the tools for any game fact; call several if needed, then answer in one short message.`,
        notes,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    const messages: LlmMessage[] = deps.context.recent(group.id, at.getTime()).map((turn) =>
      turn.role === 'assistant'
        ? { role: 'assistant', content: turn.text }
        : { role: 'user', content: `${turn.name}: ${turn.text}` },
    );
    messages.push({ role: 'user', content: `${senderName}: ${question}` });

    let text: string | null = null;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (!(await takeCall())) return { kind: 'silent', reason: 'call_ceiling' };
        const response = await deps.provider.generate({
          system,
          messages: [...messages],
          // The last round gets no tools, so the model has to answer with what it holds.
          tools: round < MAX_TOOL_ROUNDS ? tools.definitions : undefined,
          maxTokens: REPLY_MAX_TOKENS,
          temperature: 0.9,
        });
        deps.log.info(
          {
            event: 'chat.llm',
            group: tag(group.id),
            sender: tag(message.sender),
            round,
            latencyMs: response.latencyMs,
            tokens: response.usage,
            toolCalls: response.toolCalls.map((c) => c.name),
          },
          'llm answered',
        );
        if (response.toolCalls.length === 0) {
          text = response.text;
          break;
        }
        messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          let args: unknown = {};
          try {
            args = JSON.parse(call.arguments || '{}');
          } catch {
            args = {};
          }
          const result = await tools.run(call.name, args);
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (error) {
      if (error instanceof LlmUnavailable) {
        deps.log.warn(
          { event: 'chat.unavailable', group: tag(group.id), error: error.message },
          'no answer: model unavailable',
        );
        return { kind: 'silent', reason: 'unavailable' };
      }
      throw error;
    }

    const reply = plainReply(text);
    if (!reply) return { kind: 'silent', reason: 'empty' };
    deps.context.push(group.id, { role: 'user', name: senderName, text: question, at: at.getTime() });
    deps.context.push(group.id, { role: 'assistant', name: '', text: reply, at: at.getTime() });
    return { kind: 'reply', text: reply };
  };
}
