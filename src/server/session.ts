import { randomUUID } from 'node:crypto';
import type { OpenApiDocument } from 'syncables';
import type { ZipperConfig } from '../config/index.js';
import { TokenManager } from '../google/authed-fetch.js';
import type { GoogleAccount, GoogleTokens } from '../google/oauth.js';
import { TokenStore } from '../google/token-store.js';
import { SyncEngine } from '../sync/engine.js';

export interface ActiveSession {
  sessionId: string;
  account: GoogleAccount;
  connectedAt: number;
  tokens: TokenManager;
  engine: SyncEngine;
}

/**
 * Holds the single connected account for this Zipper instance (a personal,
 * self-hosted tool). Tokens are persisted to disk via {@link TokenStore} so a
 * connection survives restarts; the in-memory {@link SyncEngine} is rebuilt
 * from them on startup.
 */
export class SessionManager {
  private readonly store: TokenStore;
  private active: ActiveSession | undefined;

  constructor(
    private readonly config: ZipperConfig,
    private readonly document: OpenApiDocument,
  ) {
    this.store = new TokenStore(config.tokenStorePath);
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
    tokens: GoogleTokens,
    account: GoogleAccount,
    connectedAt: number,
  ): ActiveSession {
    const manager = new TokenManager(this.config, tokens, fetch, (next) => {
      void this.store.saveTokens(next);
    });
    return {
      sessionId,
      account,
      connectedAt,
      tokens: manager,
      engine: new SyncEngine(this.config, this.document, manager),
    };
  }

  /** Establishes a new session after a successful OAuth exchange. */
  async connect(
    tokens: GoogleTokens,
    account: GoogleAccount,
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
