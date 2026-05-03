import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'dev-agent',
  description: 'Agentic feature development cockpit',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
