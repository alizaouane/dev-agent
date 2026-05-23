import type { ReactNode } from 'react';
import { Term } from '@/components/ui/term';
import type { TermKey } from '@/lib/glossary';

type PageHeaderProps = {
  title: string;
  descriptor: string;
  /** Optional: shows a (?) bubble next to the title that opens the term's popover. */
  helpTerm?: TermKey;
  /** Right-side slot for primary CTAs. */
  actions?: ReactNode;
};

export function PageHeader({ title, descriptor, helpTerm, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {helpTerm && <Term k={helpTerm} variant="icon" />}
        </div>
        <p className="mt-1 text-sm italic text-muted-foreground">{descriptor}</p>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
