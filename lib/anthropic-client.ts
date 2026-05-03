import { createHash } from 'node:crypto';

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

export async function invokeAnthropic(args: InvokeArgs): Promise<InvokeResult> {
  const mode = resolveMode(args.mode);
  if (mode === 'stub') return deterministicStub(args);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for live invocation mode');
  }
  throw new Error('LIVE_MODE_NOT_WIRED_UNTIL_1D — set INVOCATION_MODE=stub to proceed');
}
