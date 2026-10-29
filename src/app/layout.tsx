import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Imprimatur — brand governance review',
  description: 'Pre-publication review gate: every finding cites its evidence, every approval is a human decision.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
