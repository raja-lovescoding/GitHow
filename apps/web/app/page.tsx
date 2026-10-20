'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'GitHow';

export default function Home() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const parsed = new URL(url);
      if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) {
        throw new Error('Please enter a valid github.com repository URL.');
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) {
        throw new Error('Please enter a repository URL in the format https://github.com/owner/repository.');
      }
      router.push(`/${parts[0]}/${parts[1]}`);
    } catch (submissionError) {
      setError((submissionError as Error).message);
    }
  }

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', fontSize: 15 }}>
            {PRODUCT_NAME.toUpperCase()}
          </strong>
          <span className="brand-badge">RIG</span>
        </div>
        <span>Repository intelligence, starting with the immutable commit.</span>
      </nav>

      <section className="home-hero">
        <p style={{ font: '600 12px var(--font-mono)', color: 'var(--muted)', letterSpacing: '0.1em', margin: 0 }}>
          REPOSITORY INTELLIGENCE GRAPH · INTERACTIVE WORKSPACE
        </p>
        <h1>See what a codebase is made of.</h1>
        <p className="lede">
          Paste any public GitHub repository. {PRODUCT_NAME} resolves its immutable commit, safely parses the code
          hierarchy, and models control flow and data flow across framework boundaries.
        </p>

        <form onSubmit={submit} className="home-form">
          <label htmlFor="repo-url" style={{ display: 'block', font: '600 12px var(--font-mono)', marginBottom: 10, color: 'var(--muted)' }}>
            GitHub Repository URL
          </label>
          <div className="home-input-row">
            <input
              id="repo-url"
              className="home-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/hagopj13/node-express-boilerplate"
              autoFocus
            />
            <button type="submit" className="home-submit-btn">
              <span>Inspect Repository</span>
              <span>→</span>
            </button>
          </div>
          {error && <p style={{ color: 'var(--red)', font: '500 12px var(--font-mono)', marginTop: 10 }}>{error}</p>}
        </form>
      </section>

      <section className="home-principles">
        <div className="home-principle-card">
          <b>01 / IMMUTABLE</b>
          <span>Commit-Tied Snapshots</span>
          <p>Every analysis is resolved against a verified commit SHA for deterministic results.</p>
        </div>
        <div className="home-principle-card">
          <b>02 / HONEST BOUNDARIES</b>
          <span>Static Certainty</span>
          <p>Clear distinction between statically resolved relationships and unresolved dynamic boundaries.</p>
        </div>
        <div className="home-principle-card">
          <b>03 / SECURE ISOLATION</b>
          <span>Non-Executable Analysis</span>
          <p>Analyzed code is safely inspected via AST parsing and never executed in the runtime environment.</p>
        </div>
      </section>
    </main>
  );
}
