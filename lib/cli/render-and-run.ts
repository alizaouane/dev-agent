#!/usr/bin/env tsx
import { renderPrompt } from '../render-prompt';
import { invokeAnthropic } from '../anthropic-client';
import type { ExpectedPrompt } from '../plugin-files';

async function main(): Promise<void> {
  const promptName = process.argv[2] as ExpectedPrompt | undefined;
  if (!promptName) {
    console.error('usage: render-and-run.ts <prompt-name>');
    process.exit(2);
  }
  const varsRaw = process.env.PROMPT_VARS_JSON ?? '{}';
  const vars = JSON.parse(varsRaw) as Record<string, unknown>;
  const rendered = renderPrompt(promptName, vars);

  const result = await invokeAnthropic({
    mode: 'auto',
    model: process.env.MODEL ?? 'claude-haiku-4-5',
    system: rendered,
    user: process.env.USER_INPUT ?? '',
  });

  console.log(JSON.stringify({
    text: result.text,
    usage: result.usage,
    model: result.model,
  }));
}

main().catch((err) => {
  console.error(`render-and-run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
