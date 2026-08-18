import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OpenApiDocument } from 'syncables';
import { buildDocumentFrom } from '../../../src/sync/document.js';
import {
  discoverResourceModel,
  type ResourceModel,
} from '../../../src/sync/resources.js';
import type { AuthorizedFetcher, PathParams } from '../../../src/oauth/authed-fetch.js';
import { ReflectionEngine, type ReflectionSide } from '../../../src/reflect/engine.js';
import { InMemoryIdMap } from '../../../src/reflect/id-map.js';
import { parseMarker } from '../../../src/reflect/marker.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
}

/** A tiny in-memory GitHub Issues API for two repositories. */
class FakeGitHub {
  private readonly repos = new Map<string, Issue[]>();
  private seq = 1000;

  seed(repo: string, issues: Omit<Issue, 'id'>[]): void {
    this.repos.set(
      repo,
      issues.map((i) => ({ ...i, id: (this.seq += 1) })),
    );
  }

  issues(repo: string): Issue[] {
    return this.repos.get(repo) ?? [];
  }

  /** An AuthorizedFetcher bound to a repo context, routing to this store. */
  authFor(): AuthorizedFetcher {
    return {
      authorizedFetch: (params: PathParams = {}): typeof fetch => {
        const impl = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = new URL(
            typeof input === 'string' ? input : input.toString(),
          );
          let path = url.pathname;
          for (const [k, v] of Object.entries(params)) {
            path = path
              .replaceAll(`{${k}}`, v)
              .replaceAll(`%7B${k}%7D`, v)
              .replaceAll(`%7b${k}%7d`, v);
          }
          return this.route((init?.method ?? 'GET').toUpperCase(), path, init);
        };
        return impl as typeof fetch;
      },
    };
  }

  private route(method: string, path: string, init?: RequestInit): Response {
    const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    const item = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (list) {
      const repo = `${list[1]}/${list[2]}`;
      const issues = this.issues(repo);
      if (method === 'GET') {
        return json(issues);
      }
      if (method === 'POST') {
        const b = JSON.parse(String(init?.body ?? '{}')) as Partial<Issue>;
        this.seq += 1;
        const created: Issue = {
          id: this.seq,
          number: this.seq,
          title: b.title ?? '',
          body: b.body ?? '',
          state: 'open',
        };
        issues.push(created);
        this.repos.set(repo, issues);
        return json(created, 201);
      }
    }
    if (item && method === 'PATCH') {
      const repo = `${item[1]}/${item[2]}`;
      const number = Number(item[3]);
      const found = this.issues(repo).find((i) => i.number === number);
      if (!found) return new Response('not found', { status: 404 });
      const b = JSON.parse(String(init?.body ?? '{}')) as Partial<Issue>;
      Object.assign(found, b);
      return json(found);
    }
    return new Response('not found', { status: 404 });
  }
}

const RETRY = { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 3 };

describe('ReflectionEngine (issues)', () => {
  let document: OpenApiDocument;
  let model: ResourceModel;

  beforeAll(async () => {
    document = await buildDocumentFrom(
      resolve(repoRoot, 'spec/github-issues.openapi.yaml'),
      resolve(repoRoot, 'spec/overlays/github'),
    );
    model = discoverResourceModel(document);
  });

  const sides = (fake: FakeGitHub): [ReflectionSide, ReflectionSide] => [
    {
      system: 'octo/a',
      document,
      model,
      auth: fake.authFor(),
      context: { owner: 'octo', repo: 'a' },
    },
    {
      system: 'octo/b',
      document,
      model,
      auth: fake.authFor(),
      context: { owner: 'octo', repo: 'b' },
    },
  ];

  it('reflects an original issue onto the other side with a back-link marker', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);

    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      retry: RETRY,
      drainTimeoutMs: 2000,
    });
    const summary = await engine.reflect();

    expect(summary.errors).toEqual([]);
    const copies = fake.issues('octo/b');
    expect(copies).toHaveLength(1);
    expect(copies[0]?.title).toBe('Bug');
    expect(copies[0]?.body).toContain('It broke');
    const marker = parseMarker(copies[0]?.body ?? '');
    expect(marker).toEqual({ system: 'octo/a', kind: 'issue', id: '1' });
  });

  it('does not duplicate on repeated passes and does not echo the copy back', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);

    const [a, b] = sides(fake);
    const idMap = new InMemoryIdMap();
    const engine = new ReflectionEngine(a, b, idMap, {
      retry: RETRY,
      drainTimeoutMs: 2000,
    });

    await engine.reflect();
    await engine.reflect();
    await engine.reflect();

    // Exactly one copy on B, and A still has only its original (no echo back).
    expect(fake.issues('octo/b')).toHaveLength(1);
    expect(fake.issues('octo/a')).toHaveLength(1);
  });

  it('is idempotent even with a fresh (lost) id-map, via the destination marker scan', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'Bug', body: 'It broke', state: 'open' },
    ]);
    fake.seed('octo/b', []);
    const [a, b] = sides(fake);

    await new ReflectionEngine(a, b, new InMemoryIdMap(), {
      retry: RETRY,
      drainTimeoutMs: 2000,
    }).reflect();
    // Second run with a brand-new id-map (as if persistence was wiped).
    await new ReflectionEngine(a, b, new InMemoryIdMap(), {
      retry: RETRY,
      drainTimeoutMs: 2000,
    }).reflect();

    expect(fake.issues('octo/b')).toHaveLength(1);
  });

  it('reflects originals created on either side (bidirectional)', async () => {
    const fake = new FakeGitHub();
    fake.seed('octo/a', [
      { number: 1, title: 'From A', body: 'a-body', state: 'open' },
    ]);
    fake.seed('octo/b', [
      { number: 5, title: 'From B', body: 'b-body', state: 'open' },
    ]);
    const [a, b] = sides(fake);
    const engine = new ReflectionEngine(a, b, new InMemoryIdMap(), {
      retry: RETRY,
      drainTimeoutMs: 2000,
    });

    await engine.reflect();
    await engine.reflect();

    // Each side ends with its original plus one reflected copy of the other's.
    expect(fake.issues('octo/a')).toHaveLength(2);
    expect(fake.issues('octo/b')).toHaveLength(2);
    const aTitles = fake
      .issues('octo/a')
      .map((i) => i.title)
      .sort();
    expect(aTitles).toEqual(['From A', 'From B']);
  });
});
