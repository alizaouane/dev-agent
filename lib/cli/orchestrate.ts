#!/usr/bin/env tsx
import { validateTransition, type StateLabel, type TransitionTrigger } from '../orchestrator';

const FROM = process.env.FROM_STATE as StateLabel | undefined;
const TRIGGER = process.env.TRIGGER as TransitionTrigger | undefined;

function main(): void {
  if (!FROM || !TRIGGER) {
    console.error('usage: FROM_STATE=<label> TRIGGER=<trigger> orchestrate.ts');
    process.exit(2);
  }
  const result = validateTransition(FROM, TRIGGER);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

main();
