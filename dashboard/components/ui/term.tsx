'use client';

import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import { GLOSSARY, type TermKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';

type TermProps = {
  /** Glossary key — must exist in GLOSSARY. */
  k: TermKey;
  /** Override display label (defaults to GLOSSARY[k].label). */
  label?: string;
  /** Render mode. `inline` (default) underlines the label in-flow.
   *  `icon` renders a small (?) bubble — use next to section headings. */
  variant?: 'inline' | 'icon';
  /** Extra classes appended to the trigger. */
  className?: string;
};

export function Term({ k, label, variant = 'inline', className }: TermProps) {
  const entry = GLOSSARY[k as keyof typeof GLOSSARY] as (typeof GLOSSARY)[keyof typeof GLOSSARY] | undefined;

  // Warn synchronously in dev so the warning is observable in the same render
  // tick within tests (avoids flakiness from useEffect async scheduling).
  if (!entry && process.env.NODE_ENV !== 'production') {
    console.warn(`<Term> unknown key: ${k}`);
  }

  if (!entry) {
    return <span className={className}>{label ?? String(k)}</span>;
  }

  const displayLabel = label ?? entry.label;

  // Deviation from plan: triggerClass is placed directly on the Popover.Trigger
  // button (not on an inner <span>) so that getByText(displayLabel) returns the
  // element that carries the class. The inner <span tabIndex={0}> wrapper is
  // omitted because Popover.Trigger is already a focusable button element.
  const triggerClass =
    variant === 'inline'
      ? cn(
          'border-b border-dotted border-accent cursor-help text-inherit',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
          className,
        )
      : cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] leading-none text-muted-foreground hover:border-accent hover:text-accent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className,
        );

  const ariaLabel =
    variant === 'icon' ? `What is ${entry.label}?` : entry.label;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Popover.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <Popover.Trigger
              type="button"
              className={triggerClass}
              aria-label={variant === 'icon' ? ariaLabel : undefined}
            >
              {variant === 'inline' ? (
                displayLabel
              ) : (
                <span aria-hidden="true">?</span>
              )}
            </Popover.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={6}
              className="z-50 max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow"
            >
              {entry.short}
              <Tooltip.Arrow className="fill-popover" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            className="z-50 w-80 rounded-md border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
          >
            <div className="mb-1 font-semibold">{entry.label}</div>
            <p className="text-muted-foreground">{entry.long}</p>
            {entry.link && (
              <a
                href={entry.link}
                className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
                target={entry.link.startsWith('http') ? '_blank' : undefined}
                rel={entry.link.startsWith('http') ? 'noopener noreferrer' : undefined}
              >
                Learn more →
              </a>
            )}
            <Popover.Arrow className="fill-popover" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}
