import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';

import {
  DRAFT_STORAGE_KEY,
  clearDraft,
  loadDraft,
  saveDraft,
  type PersistedDraft,
} from '@/lib/pm-chat-draft';

/** Minimal in-memory Storage stand-in. Avoids relying on jsdom quirks. */
function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const fakeMessage = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

describe('loadDraft / saveDraft / clearDraft', () => {
  it('round-trips a full draft', () => {
    const storage = makeStorage();
    const draft: PersistedDraft = {
      repo: 'q/r',
      title: 'Add refunds',
      input: 'partial draft',
      messages: [fakeMessage('m1', 'hi'), fakeMessage('m2', 'pm reply')],
    };
    saveDraft(draft, storage);
    const loaded = loadDraft(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.repo).toBe('q/r');
    expect(loaded!.title).toBe('Add refunds');
    expect(loaded!.input).toBe('partial draft');
    expect(loaded!.messages).toHaveLength(2);
  });

  it('returns null when no draft is stored', () => {
    expect(loadDraft(makeStorage())).toBeNull();
  });

  it('returns null on corrupted JSON', () => {
    const storage = makeStorage({ [DRAFT_STORAGE_KEY]: '{not json' });
    expect(loadDraft(storage)).toBeNull();
  });

  it('returns null when messages field is missing or wrong type', () => {
    const storage = makeStorage({
      [DRAFT_STORAGE_KEY]: JSON.stringify({ repo: 'q/r', title: 't', input: 'i' }),
    });
    expect(loadDraft(storage)).toBeNull();

    const storage2 = makeStorage({
      [DRAFT_STORAGE_KEY]: JSON.stringify({ messages: 'not an array' }),
    });
    expect(loadDraft(storage2)).toBeNull();
  });

  it('coerces missing scalar fields to empty strings', () => {
    const storage = makeStorage({
      [DRAFT_STORAGE_KEY]: JSON.stringify({ messages: [] }),
    });
    const loaded = loadDraft(storage);
    expect(loaded).toEqual({ repo: '', title: '', input: '', messages: [] });
  });

  it('clearDraft removes the stored entry', () => {
    const storage = makeStorage();
    saveDraft({ repo: 'q/r', title: 't', input: 'i', messages: [] }, storage);
    expect(loadDraft(storage)).not.toBeNull();
    clearDraft(storage);
    expect(loadDraft(storage)).toBeNull();
  });

  it('saveDraft is a no-op when storage is null (SSR-safe)', () => {
    expect(() =>
      saveDraft({ repo: '', title: '', input: '', messages: [] }, null),
    ).not.toThrow();
  });

  it('saveDraft swallows quota / private-mode errors', () => {
    const broken: Pick<Storage, 'setItem'> = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() =>
      saveDraft({ repo: '', title: '', input: '', messages: [] }, broken),
    ).not.toThrow();
  });
});
