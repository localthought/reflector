import { join } from 'node:path';
import type { ReflectionEndpoint, ReflectorConfig } from '../config/index.js';
import { deriveApiBase } from '../oauth/oauth.js';
import { StaticTokenManager } from '../oauth/static-token.js';
import { buildDocumentFrom } from '../sync/document.js';
import { discoverResourceModel } from '../sync/resources.js';
import {
  ReflectionEngine,
  type ReflectionSide,
  type ReflectionSummary,
} from './engine.js';
import { FileIdMap } from './id-map.js';
import { FileKvStore } from './kv-store.js';

/**
 * Extracts `[owner, repo]` from a reflection target: either the documented
 * "owner/repo" shorthand, or a full repository URL (e.g.
 * `https://github.com/owner/repo`, optionally with a trailing `/issues`,
 * `.git`, or `/`) — pasting the browser URL instead of the shorthand is an
 * easy mistake (localthought/reflector#31), so it's accepted rather than
 * silently mis-parsed.
 */
function parseOwnerRepo(target: string): [string, string] | undefined {
  if (!target.includes('://')) {
    const parts = target.split('/');
    return parts.length === 2 && parts[0] && parts[1]
      ? [parts[0], parts[1]]
      : undefined;
  }
  try {
    const parts = new URL(target).pathname.split('/').filter(Boolean);
    return parts.length >= 2
      ? [parts[0], parts[1].replace(/\.git$/, '')]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a reflection target into the path context the document expects. */
function targetContext(target: string): Record<string, string> {
  const parsed = parseOwnerRepo(target);
  if (!parsed) {
    throw new Error(
      `Reflection target "${target}" must be in "owner/repo" form, or a ` +
        'full repository URL (e.g. "https://github.com/owner/repo").',
    );
  }
  const [owner, repo] = parsed;
  return { owner, repo };
}

async function buildSide(
  endpoint: ReflectionEndpoint,
): Promise<ReflectionSide> {
  const document = await buildDocumentFrom(
    endpoint.openApiPath,
    endpoint.overlayDir,
  );
  const model = discoverResourceModel(document);
  const auth = new StaticTokenManager(deriveApiBase(document), endpoint.token);
  return {
    system: endpoint.target,
    document,
    model,
    auth,
    context: targetContext(endpoint.target),
  };
}

/** A summary plus when it ran, for the status endpoint. */
export interface ReflectionRun {
  at: string;
  summary: ReflectionSummary;
}

/**
 * Runs the reflection engine on a background interval and on demand.
 *
 * `reflectNow()` is the "reflect now" seam (an HTTP trigger, or a live-test
 * harness kick) and the loop both go through one serialized chain, so a manual
 * trigger and a scheduled tick never overlap. The id-map and state ledger are
 * persisted under `${DATA_DIR}/reflect`; on an ephemeral host that directory is
 * lost on restart, but reflection stays duplicate-free because the engine
 * re-derives links from the destination's markers.
 */
export class ReflectionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private lastRun: ReflectionRun | undefined;
  private lastError: string | undefined;

  private constructor(
    private readonly engine: ReflectionEngine,
    private readonly intervalMs: number,
    private readonly direction: 'bidirectional' | 'a-to-b',
    private readonly systems: [string, string],
  ) {}

  /** Builds the service from config, or `undefined` when reflection is off. */
  static async fromConfig(
    config: ReflectorConfig,
  ): Promise<ReflectionService | undefined> {
    if (!config.reflection.enabled) {
      return undefined;
    }
    const [a, b] = await Promise.all([
      buildSide(config.reflection.a),
      buildSide(config.reflection.b),
    ]);
    const dir = join(config.dataDir, 'reflect');
    const idMap = await FileIdMap.open(join(dir, 'id-map.json'));
    const stateLedger = await FileKvStore.open(join(dir, 'state.json'));
    const engine = new ReflectionEngine(a, b, idMap, {
      direction: config.reflection.direction,
      retry: config.retry,
      stateLedger,
    });
    return new ReflectionService(
      engine,
      config.reflection.intervalMs,
      config.reflection.direction,
      [a.system, b.system],
    );
  }

  /** Triggers one reflection pass, serialized with the loop and other triggers. */
  async reflectNow(): Promise<ReflectionSummary> {
    const run = this.chain.then(() => this.engine.reflect());
    // Keep the chain alive regardless of this run's outcome.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      const summary = await run;
      this.lastRun = { at: new Date().toISOString(), summary };
      this.lastError = undefined;
      return summary;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Starts the background loop (an immediate pass, then every `intervalMs`). */
  start(): void {
    if (this.timer) {
      return;
    }
    const tick = (): void => {
      void this.reflectNow().catch((error: unknown) => {
        console.error('Reflection pass failed:', error);
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  status(): {
    enabled: true;
    direction: string;
    intervalMs: number;
    systems: [string, string];
    lastRun?: ReflectionRun;
    lastError?: string;
  } {
    return {
      enabled: true,
      direction: this.direction,
      intervalMs: this.intervalMs,
      systems: this.systems,
      ...(this.lastRun ? { lastRun: this.lastRun } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
