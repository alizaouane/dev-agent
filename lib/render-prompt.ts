import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { EXPECTED_PROMPTS, type ExpectedPrompt } from './plugin-files';

const promptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export type PromptVariables = Record<string, unknown>;

export function renderPrompt(name: ExpectedPrompt, vars: PromptVariables): string {
  if (!EXPECTED_PROMPTS.includes(name)) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const path = resolve(promptsDir, `${name}.md`);
  if (!existsSync(path)) {
    throw new Error(`Prompt template not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const template = Handlebars.compile(raw, { strict: true, noEscape: true });
  try {
    return template(vars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`renderPrompt(${name}): missing variable — ${msg}`);
  }
}
