import { randomUUID } from 'node:crypto';
import type { OpenApiDocument } from 'syncables';
import type { ReflectorConfig } from '../config/index.js';
import { TokenManager } from '../oauth/authed-fetch.js';
import type { AccountInfo, AuthProfile, OAuthTokens } from '../oauth/oauth.js';
import { TokenStore } from '../oauth/token-store.js';
import type { RemoteStorageManager } from '../remotestorage/manager.js';
import { SyncEngine } from '../sync/engine.js';
import { FileStorageBackend, type StorageBackend } from '../sync/storage.js';

export interface ActiveSession {
  sessionId: string;
  account: AccountInfo;
  connectedAt: number;
  tokens: TokenManager;
  engine: SyncEngine;
}

/**
 * Holds the single connected account for this Reflector instance (a personal,
 * self-hosted tool). Tokens are persisted to disk via {@link TokenStore} so a
 * connection survives restarts; the in-memory {@link SyncEngine} is rebuilt
 * from them on startup.
 */
export class SessionManager {
  private readonly store: TokenStore;
  private active: ActiveSession | undefined;

  constructor(
    private readonly config: ReflectorConfig,
    private readonly document: OpenApiDocument,
    private readonly profile: AuthProfile,
    private readonly remoteStorage: RemoteStorageManager,
  ) {
    this.store = new TokenStore(config.tokenStorePath);
  }

  /** The storage backend the current session's engine should use. */
  private backend(): StorageBackend {
    return (
      this.remoteStorage.backend() ??
      new FileStorageBackend(this.config.dataDir)
    );
  }

  /** Rebuilds the session from persisted tokens, if any, at startup. */
  async restore(): Promise<void> {
    const stored = await this.store.load();
    if (stored) {
      this.active = this.build(
        stored.sessionId,
        stored.tokens,
        stored.account,
        stored.connectedAt,
      );
    }
  }

  private build(
    sessionId: string,
    tokens: OAuthTokens,
    account: AccountInfo,
    connectedAt: number,
  ): ActiveSession {
    const manager = new TokenManager(
      this.profile,
      this.config.oauth,
      tokens,
      fetch,
      (next) => {
        void this.store.saveTokens(next);
      },
    );
    return {
      sessionId,
      account,
      connectedAt,
      tokens: manager,
      engine: new SyncEngine(
        this.config,
        this.document,
        manager,
        this.backend(),
      ),
    };
  }

  /**
   * Rebuilds the active session's engine against the current storage backend.
   * Called after a remoteStorage account is connected or disconnected so the
   * local-first copy moves to (or away from) the user's account. A fresh
   * full read repopulates the new location.
   */
  rebuildEngine(): void {
    if (!this.active) {
      return;
    }
    this.active.engine = new SyncEngine(
      this.config,
      this.document,
      this.active.tokens,
      this.backend(),
    );
  }

  /** Establishes a new session after a successful OAuth exchange. */
  async connect(
    tokens: OAuthTokens,
    account: AccountInfo,
  ): Promise<ActiveSession> {
    const sessionId = randomUUID();
    const connectedAt = Date.now();
    await this.store.save({ sessionId, tokens, account, connectedAt });
    this.active = this.build(sessionId, tokens, account, connectedAt);
    return this.active;
  }

  async disconnect(): Promise<void> {
    this.active = undefined;
    await this.store.clear();
  }

  /** Returns the session only if the presented cookie matches it. */
  authorized(sessionId: string | undefined): ActiveSession | undefined {
    if (this.active && sessionId && sessionId === this.active.sessionId) {
      return this.active;
    }
    return undefined;
  }

  current(): ActiveSession | undefined {
    return this.active;
  }
}
