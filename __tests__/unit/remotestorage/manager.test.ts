import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteStorageManager } from '../../../src/remotestorage/manager.js';

const AUTH_PROP = 'http://tools.ietf.org/html/rfc6749#section-4.2';

function webfingerFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        links: [
          {
            rel: 'remotestorage',
            href: 'https://storage.example/me/',
            properties: { [AUTH_PROP]: 'https://storage.example/oauth/me' },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/jrd+json' } },
    ),
  ) as unknown as typeof fetch;
}

const OPTIONS = {
  module: 'reflector',
  clientId: 'https://reflector.example',
  redirectUri: 'https://reflector.example/remotestorage/callback',
};

describe('RemoteStorageManager', () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-rs-'));
    storePath = join(dir, 'remotestorage.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts out local with no connection', () => {
    const manager = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    expect(manager.current()).toBeUndefined();
    expect(manager.backend()).toBeUndefined();
    expect(manager.status()).toEqual({
      kind: 'local',
      label: 'Local files',
      userAddress: null,
    });
  });

  it('builds an OAuth authorize URL from WebFinger discovery', async () => {
    const manager = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    const { authUrl, state } = await manager.beginConnect('me@storage.example');

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://storage.example/oauth/me');
    expect(url.searchParams.get('redirect_uri')).toBe(OPTIONS.redirectUri);
    expect(url.searchParams.get('client_id')).toBe(OPTIONS.clientId);
    expect(url.searchParams.get('scope')).toBe('reflector:rw');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('completes a connection, persists it, and exposes a backend', async () => {
    const manager = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    const { state } = await manager.beginConnect('me@storage.example');
    const connection = await manager.completeConnect(state, 'the-token');

    expect(connection).toMatchObject({
      userAddress: 'me@storage.example',
      href: 'https://storage.example/me',
      module: 'reflector',
      token: 'the-token',
    });
    expect(manager.backend()?.label).toBe('remoteStorage: me@storage.example');
    expect(manager.status()).toEqual({
      kind: 'remotestorage',
      label: 'remoteStorage: me@storage.example',
      userAddress: 'me@storage.example',
    });

    // Persisted: a fresh manager restores the same connection.
    const restored = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    await restored.restore();
    expect(restored.current()?.token).toBe('the-token');
    expect(restored.status().kind).toBe('remotestorage');
  });

  it('rejects completing an unknown or reused state', async () => {
    const manager = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    await expect(manager.completeConnect('nope', 'tok')).rejects.toThrow(
      /Unknown or expired/,
    );

    const { state } = await manager.beginConnect('me@storage.example');
    await manager.completeConnect(state, 'tok');
    // The state is single-use.
    await expect(manager.completeConnect(state, 'tok')).rejects.toThrow(
      /Unknown or expired/,
    );
  });

  it('disconnects back to local storage', async () => {
    const manager = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    const { state } = await manager.beginConnect('me@storage.example');
    await manager.completeConnect(state, 'tok');

    await manager.disconnect();
    expect(manager.current()).toBeUndefined();
    expect(manager.backend()).toBeUndefined();
    expect(manager.status().kind).toBe('local');

    const restored = new RemoteStorageManager(storePath, OPTIONS, webfingerFetch());
    await restored.restore();
    expect(restored.current()).toBeUndefined();
  });
});
