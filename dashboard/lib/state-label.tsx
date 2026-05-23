import type { ReactNode } from 'react';
import { Term } from '@/components/ui/term';

/** Strip the `state:` prefix and render the label, wrapping it in a `<Term>`
 *  when it matches a glossary key (currently `tier2-smoke` and `gate-b`).
 *  Used by feature-card, feature-detail, inbox-item — keep them in sync by
 *  routing all state-badge rendering through here. */
export function renderStateBadgeContent(state: string): ReactNode {
  const stateLabel = state.replace('state:', '');
  if (stateLabel === 'tier2-smoke') return <Term k="tier2-smoke" label={stateLabel} />;
  if (/^gate[\s-]?b$/i.test(stateLabel)) return <Term k="gate-b" label={stateLabel} />;
  return stateLabel;
}
