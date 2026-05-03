import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { usageToDollars } from './pricing';

export type InvocationMode = 'stub' | 'live' | 'auto';

export type InvokeArgs = {
  mode: InvocationMode;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
};

export type InvokeResult = {
  text: string;
  usage: { tokens_in: number; tokens_out: number; dollars: number };
  model: string;
};

function resolveMode(mode: InvocationMode): 'stub' | 'live' {
  if (mode !== 'auto') return mode;
  return process.env.INVOCATION_MODE === 'live' ? 'live' : 'stub';
}

function deterministicStub(args: InvokeArgs): InvokeResult {
  const fingerprint = createHash('sha256')
    .update(`${args.model}\n${args.system}\n${args.user}`)
    .digest('hex')
    .slice(0, 12);
  const tokens_in = Math.max(1, (args.system.length + args.user.length) >> 2);
  const tokens_out = 64;
  return {
    text: `STUB[${fingerprint}]: ${args.model} would respond here in live mode.`,
    usage: { tokens_in, tokens_out, dollars: 0 },
    model: args.model,
  };
}

async function liveInvoke(args: InvokeArgs): Promise<InvokeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for live invocation mode');
  }
  const client = new Anthropic();
  const userText = args.user.length > 0 ? args.user : '(continue)';
  const response = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? 16000,
    system: [
      { type: 'text', text: args.system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userText }],
  });

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }

  const u = response.usage;
  const tokens_in =
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const tokens_out = u.output_tokens;

  return {
    text,
    usage: {
      tokens_in,
      tokens_out,
      dollars: usageToDollars(args.model, u),
    },
    model: response.model ?? args.model,
  };
}

export async function invokeAnthropic(args: InvokeArgs): Promise<InvokeResult> {
  const mode = resolveMode(args.mode);
  if (mode === 'stub') return deterministicStub(args);
  return liveInvoke(args);
}
