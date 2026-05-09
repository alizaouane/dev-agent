'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';

export function HelpPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label="Help"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm hover:bg-accent"
        >
          ?
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto bg-background p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">About dev-agent</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            A 30 second pitch: dev-agent watches your wired-up repos, lets you brainstorm features
            with a PM agent, ships them through gated phases (spec → PR → promote), and runs
            verification pillars on every change so you can trust what merged.
          </Dialog.Description>
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">What to do today</h3>
            <ul className="ml-5 list-disc text-sm text-muted-foreground">
              <li>
                Check <Link className="underline" href="/" onClick={() => setOpen(false)}>Home</Link> for what needs you.
              </li>
              <li>
                Open <Link className="underline" href="/intent" onClick={() => setOpen(false)}>Brainstorm</Link> to start something new.
              </li>
            </ul>
          </div>
          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
