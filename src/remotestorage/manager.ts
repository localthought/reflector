import { randomUUID } from 'node:crypto';
import type { StorageBackend } from '../sync/storage.js';
import { RemoteStorageBackend } from './adapter.js';
import { RemoteStorageStore, type StoredRemoteStorage } from './store.js';
import { discover } from './webfinger.js';

/** How the manager is told to build OAuth authorize URLs. */
export interface RemoteStorageOptions {
  /** The storage module (top-level directory) Reflector reads and writes, e.g. `reflector`. */
  module: string;
  /** OAuth `client_id` — the app's origin, identifying Reflector to the provider. */
  clientId: string;
  /** OAuth `redirect_uri` the provider sends the implicit-grant token back to. */
  redirectUri: string;
}

/** What the UI needs to render the current storage location. */
export interface RemoteStorageStatus {
  kind: 'local' | 'remotestorage';
  label: string;
  userAddress: string | null;
}

/** A connect attempt awaiting the OAuth redirect back, keyed by `state`. */
interface PendingConnect {
  userAddress: string;
  href: string;
}

/**
 * Owns the single connected remoteStorage account for this Reflector instance: it
 * runs WebFinger discovery, hands out the OAuth authorize URL the browser is
 * sent to, completes the connection when the implicit-grant token comes back,
 * and builds the {@link StorageBackend} the {@link SyncEngine} stores its
 * local-first copy in. When nothing is connected, the engine falls back to the
 * on-disk file backend.
 */
export class RemoteStorageManager {
  private readonly store: RemoteStorageStore;
  private connection: StoredRemoteStorage | undefined;
  private readonly pending = new Map<string, PendingConnect>();

  constructor(
    storePath: string,
    private readonly options: RemoteStorageOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new RemoteStorageStore(storePath);
  }

  /** Restores a persisted connection, if any, at startup. */
  async restore(): Promise<void> {
    this.connection = await this.store.load();
  }

  /**
   * Discovers `userAddress` and returns the OAuth authorize URL to redirect the
   * browser to, plus the `state` that ties the redirect back to this attempt.
   */
  async beginConnect(
    userAddress: string,
  ): Promise<{ authUrl: string; state: string }> {
    const info = await discover(userAddress, this.fetchImpl);
    const state = randomUUID();
    this.pending.set(state, { userAddress: info.userAddress, href: info.href });

    const url = new URL(info.authUrl);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('scope', `${this.options.module}:rw`);
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('state', state);
    return { authUrl: url.toString(), state };
  }

  /**
   * Completes a connection once the implicit-grant `token` comes back for a
   * `state` from {@link beginConnect}, persisting it and making it current.
   */
  async completeConnect(
    state: string,
    token: string,
  ): Promise<StoredRemoteStorage> {
    const pending = this.pending.get(state);
    if (!pending) {
      throw new Error('Unknown or expired remoteStorage connect state.');
    }
    this.pending.delete(state);
    const connection: StoredRemoteStorage = {
      userAddress: pending.userAddress,
      href: pending.href,
      module: this.options.module,
      token,
      connectedAt: Date.now(),
    };
    await this.store.save(connection);
    this.connection = connection;
    return connection;
  }

  async disconnect(): Promise<void> {
    this.connection = undefined;
    this.pending.clear();
    await this.store.clear();
  }

  current(): StoredRemoteStorage | undefined {
    return this.connection;
  }

  /** The storage backend for the current connection, or `undefined` when local. */
  backend(): StorageBackend | undefined {
    if (!this.connection) {
      return undefined;
    }
    const base = `${this.connection.href}/${this.connection.module}`;
    return new RemoteStorageBackend(
      base,
      this.authorizedFetch(this.connection.token),
      this.connection.userAddress,
    );
  }

  status(): RemoteStorageStatus {
    if (!this.connection) {
      return { kind: 'local', label: 'Local files', userAddress: null };
    }
    return {
      kind: 'remotestorage',
      label: `remoteStorage: ${this.connection.userAddress}`,
      userAddress: this.connection.userAddress,
    };
  }

  /** A `fetch` that attaches the account's bearer token to every request. */
  private authorizedFetch(token: string): typeof fetch {
    const fetchImpl = this.fetchImpl;
    const authorized = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetchImpl(input, { ...init, headers });
    };
    return authorized as typeof fetch;
  }
}
