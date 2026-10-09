import { describe, expect, it } from 'vitest';
import { normalizeGitHubRepository, parseRepositoryPath } from './repository.js';

describe('repository identity', () => {
  it('normalizes ordinary GitHub URLs and trailing slashes', () => {
    expect(normalizeGitHubRepository('https://github.com/Facebook/React/')).toMatchObject({ owner: 'facebook', name: 'react', canonical: 'facebook/react' });
  });
  it('rejects unsupported hosts and malformed paths', () => {
    expect(() => normalizeGitHubRepository('https://gitlab.com/a/b')).toThrow();
    expect(() => normalizeGitHubRepository('https://github.com/a')).toThrow();
    expect(() => parseRepositoryPath(['about', 'team'])).toThrow();
  });
  it('accepts direct repository paths', () => {
    expect(parseRepositoryPath(['owner', 'repo'])).toMatchObject({ canonical: 'owner/repo' });
  });
});
