import type { Metadata } from 'next';
import './globals.css';
import { NavHeader } from '@/components/nav-header';

export const metadata: Metadata = {
  title: 'dev-agent',
  description: 'Agentic feature development cockpit',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-background text-foreground antialiased">
        <NavHeader />
        <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
