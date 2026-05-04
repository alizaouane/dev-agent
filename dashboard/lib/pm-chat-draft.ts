import type { UIMessage } from 'ai';

/**
 * localStorage-backed persistence for the PM chat draft. Survives page
 * reloads so a user who hits refresh mid-conversation doesn't lose
 * their context.
 *
 * Storage key is versioned (`:v1`) so a future schema change can
 * introduce a `:v2` rather than silently breaking existing drafts.
 *
 * Multi-device sync is intentionally not in scope here — a server-side
 * draft store layered on top of GitHub issues is the natural follow-up
 * if/when users start working from multiple devices.
 */

export const DRAFT_STORAGE_KEY = 'dev-agent:pm-chat:draft:v1';

export type PersistedDraft = {
  repo: string;
  title: string;
  input: string;
  messages: UIMessage[];
};

/**
 * Read the persisted draft, returning `null` for any of:
 *   - server render (no `window`)
 *   - missing key
 *   - corrupted JSON
 *   - missing required `messages` array
 *
 * Defensive parsing matters because localStorage is shared across all
 * dashboard versions/branches that have ever run on this origin —
 * a corrupted entry from a hot-fix branch shouldn't prevent the
 * production page from rendering.
 */
export function loadDraft(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined'
    ? null
    : window.localStorage,
): PersistedDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDraft>;
    if (!Array.isArray(parsed.messages)) return null;
    return {
      repo: typeof parsed.repo === 'string' ? parsed.repo : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      input: typeof parsed.input === 'string' ? parsed.input : '',
      messages: parsed.messages as UIMessage[],
    };
  } catch {
    return null;
  }
}

export function saveDraft(
  draft: PersistedDraft,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined'
    ? null
    : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Quota / private mode / etc. — persistence is best-effort.
  }
}

export function clearDraft(
  storage: Pick<Storage, 'removeItem'> | null = typeof window === 'undefined'
    ? null
    : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // ignore — same reasoning as saveDraft
  }
}
