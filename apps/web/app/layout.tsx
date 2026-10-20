import './styles.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'GitHow — Repository Intelligence Graph',
  description: 'Interactive static analysis and control-and-data-flow workspace for codebases.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
