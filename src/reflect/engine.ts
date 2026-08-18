import {
  createApiClient,
  type ApiClient,
  type OpenApiDocument,
} from 'syncables';
import {
  SYNCABLES_BASE_URL,
  type AuthorizedFetcher,
} from '../oauth/authed-fetch.js';
import { subsetDocument } from '../sync/document.js';
import type { ManagedCollection, ResourceModel } from '../sync/resources.js';
import { embedMarker, parseMarker, stripMarker } from './marker.js';
import type { IdMap, Link } from './id-map.js';
import { InMemoryKvStore, type KvStore } from './kv-store.js';

/** Context path params locating a side's collection, e.g. `{ owner, repo }`. */
export type Context = Record<string, string>;

/** One system in a reflection pair. */
export interface ReflectionSide {
  /** Stable name identifying this system (e.g. a GitHub `owner/repo`), used in markers and the id-map. */
  system: string;
  /** The prepared OpenAPI document this side is derived from. */
  document: OpenApiDocument;
  /** Resource model discovered from that document. */
  model: ResourceModel;
  /** Credentials for this side (OAuth or a static token). */
  auth: AuthorizedFetcher;
  /** Path params locating the target, e.g. `{ owner, repo }`. */
  context: Context;
}

export interface ReflectionOptions {
  direction?: 'bidirectional' | 'a-to-b';
  retry?: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number };
  /** Milliseconds to wait for a background write to settle before giving up. */
  drainTimeoutMs?: number;
  /** Persisted last-agreed state per reflected pair (for state reflection). */
  stateLedger?: KvStore;
}

/** What one `reflect()` run did. */
export interface ReflectionSummary {
  /** Records newly copied, as `{ kind, from, to }`. */
  created: { kind: string; from: string; to: string }[];
  /** State changes propagated, as `{ kind, target, state }`. */
  updated: { kind: string; target: string; state: string }[];
  errors: { kind: string; from: string; error: string }[];
}

const DEFAULT_RETRY = { baseDelayMs: 200, maxDelayMs: 4000, maxAttempts: 5 };

/** A side plus its synced issues client for this pass. */
interface Bound {
  side: ReflectionSide;
  client: ApiClient;
  collection: ManagedCollection;
}

/**
 * Reflects records between two systems.
 *
 * - **Issues** are copied each way, with a hidden marker linking every copy
 *   back to its source; a copy is never reflected onward (echo suppression) or
 *   twice (idempotency, via the {@link IdMap} plus a destination marker scan).
 * - **Open/closed state** is kept in agreement: a change on either side is
 *   propagated to the counterpart, using a persisted ledger of the last agreed
 *   state to tell which side changed and avoid bouncing (#27).
 *
 * Comments are layered on in #28. It is built on the syncables client the app
 * already uses — one client per side per collection.
 */
export class ReflectionEngine {
  private readonly direction: 'bidirectional' | 'a-to-b';
  private readonly retry: NonNullable<ReflectionOptions['retry']>;
  private readonly drainTimeoutMs: number;
  private readonly stateLedger: KvStore;

  constructor(
    private readonly a: ReflectionSide,
    private readonly b: ReflectionSide,
    private readonly idMap: IdMap,
    options: ReflectionOptions = {},
  ) {
    this.direction = options.direction ?? 'bidirectional';
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
    this.stateLedger = options.stateLedger ?? new InMemoryKvStore();
  }

  /** Runs one reflection pass: create-reflection then state reconciliation. */
  async reflect(): Promise<ReflectionSummary> {
    const summary: ReflectionSummary = { created: [], updated: [], errors: [] };
    const a = this.bind(this.a);
    const b = this.bind(this.b);
    await a.client.sync();
    await b.client.sync();

    await this.reflectCreates(a, b, summary);
    if (this.direction === 'bidirectional') {
      await this.reflectCreates(b, a, summary);
    }
    await this.reflectState(a, b, summary);
    return summary;
  }

  private bind(side: ReflectionSide): Bound {
    const collection = requireCollection(side.model, 'issues');
    const client = createApiClient(
      subsetDocument(side.document, collection.paths),
      {
        baseUrl: SYNCABLES_BASE_URL,
        fetch: side.auth.authorizedFetch(side.context),
        identityField: collection.idField,
        retry: this.retry,
      },
    );
    return { side, client, collection };
  }

  private async reflectCreates(
    from: Bound,
    to: Bound,
    summary: ReflectionSummary,
  ): Promise<void> {
    const sources = await from.client.list(from.collection.collectionUrl);
    const destIssues = await to.client.list(to.collection.collectionUrl);

    // Existing copies on the destination, keyed by the source id their marker
    // names — so a lost/empty id-map doesn't cause duplicate reflections.
    const existing = new Map<string, string>();
    for (const issue of destIssues) {
      const marker = parseMarker(bodyOf(issue));
      if (marker?.kind === 'issue' && marker.system === from.side.system) {
        existing.set(marker.id, String(issue[to.collection.idField]));
      }
    }

    for (const issue of sources) {
      const id = String(issue[from.collection.idField]);
      const marker = parseMarker(bodyOf(issue));
      // Echo: this issue is itself a copy of a `to`-side record; reflecting it
      // back would loop.
      if (marker && marker.system === to.side.system) {
        continue;
      }
      const known =
        this.idMap.counterpart('issue', from.side.system, id) ??
        (existing.has(id)
          ? { system: to.side.system, id: existing.get(id)! }
          : undefined);
      if (known) {
        await this.idMap.link(
          'issue',
          { system: from.side.system, id },
          { system: to.side.system, id: known.id },
        );
        continue;
      }

      try {
        const toId = await this.createIssueCopy(from.side, to, issue, id);
        await this.idMap.link(
          'issue',
          { system: from.side.system, id },
          { system: to.side.system, id: toId },
        );
        summary.created.push({
          kind: 'issue',
          from: `${from.side.system}#${id}`,
          to: `${to.side.system}#${toId}`,
        });
      } catch (error) {
        summary.errors.push({
          kind: 'issue',
          from: `${from.side.system}#${id}`,
          error: message(error),
        });
      }
    }
  }

  /** Creates a marked copy of `issue` on the destination and returns its new id. */
  private async createIssueCopy(
    fromSide: ReflectionSide,
    to: Bound,
    issue: Record<string, unknown>,
    sourceId: string,
  ): Promise<string> {
    const body = embedMarker(stripMarker(bodyOf(issue)), {
      system: fromSide.system,
      kind: 'issue',
      id: sourceId,
    });
    const title = typeof issue['title'] === 'string' ? issue['title'] : '';
    await to.client.create(to.collection.collectionUrl, { title, body });
    await this.drain(to.client, to.collection.collectionUrl);

    const copies = await to.client.list(to.collection.collectionUrl);
    const copy = copies.find((c) => {
      const marker = parseMarker(bodyOf(c));
      return (
        marker?.kind === 'issue' &&
        marker.system === fromSide.system &&
        marker.id === sourceId
      );
    });
    if (!copy) {
      throw new Error('created copy not found after write settled');
    }
    return String(copy[to.collection.idField]);
  }

  /**
   * Propagates open/closed state across each reflected issue pair. A ledger of
   * the last agreed state per pair identifies which side changed: that side's
   * state is written to the other. When neither matches the ledger (or there is
   * no ledger yet) the **original** wins, so a fresh run converges without
   * bouncing.
   */
  private async reflectState(
    a: Bound,
    b: Bound,
    summary: ReflectionSummary,
  ): Promise<void> {
    for (const pair of this.idMap.links('issue')) {
      const aEnd = endFor(pair, a.side.system);
      const bEnd = endFor(pair, b.side.system);
      if (!aEnd || !bEnd) {
        continue; // a link to some other system
      }
      const aIssue = await a.client.get(a.collection.collectionUrl, aEnd.id);
      const bIssue = await b.client.get(b.collection.collectionUrl, bEnd.id);
      if (!aIssue || !bIssue) {
        continue;
      }
      const aState = stateOf(aIssue);
      const bState = stateOf(bIssue);
      const key = pairKey(a.side.system, aEnd.id, b.side.system, bEnd.id);
      const last = this.stateLedger.get(key);

      if (aState === bState) {
        if (last !== aState) {
          await this.stateLedger.set(key, aState);
        }
        continue;
      }

      // Diverged — decide the winning state and which side to write.
      let winner: string;
      let target: Bound;
      let targetId: string;
      if (last !== undefined && aState !== last && bState === last) {
        winner = aState;
        target = b;
        targetId = bEnd.id;
      } else if (last !== undefined && bState !== last && aState === last) {
        winner = bState;
        target = a;
        targetId = aEnd.id;
      } else {
        // No ledger, or both changed: the original is authoritative.
        const aIsCopy = parseMarker(bodyOf(aIssue))?.system === b.side.system;
        if (aIsCopy) {
          winner = bState;
          target = a;
          targetId = aEnd.id;
        } else {
          winner = aState;
          target = b;
          targetId = bEnd.id;
        }
      }

      try {
        await this.setState(target, targetId, winner);
        await this.stateLedger.set(key, winner);
        summary.updated.push({
          kind: 'issue',
          target: `${target.side.system}#${targetId}`,
          state: winner,
        });
      } catch (error) {
        summary.errors.push({
          kind: 'issue',
          from: `${target.side.system}#${targetId}`,
          error: message(error),
        });
      }
    }
  }

  private async setState(
    target: Bound,
    id: string,
    state: string,
  ): Promise<void> {
    await target.client.update(target.collection.collectionUrl, id, { state });
    await this.drain(target.client, target.collection.collectionUrl);
  }

  /** Waits until the client has no pending background writes for `collectionUrl`. */
  private async drain(client: ApiClient, collectionUrl: string): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    for (;;) {
      const pending = client.pendingWrites(collectionUrl);
      if (pending.length === 0) {
        return;
      }
      const stuck = pending.find(
        (w) => w.attempts >= this.retry.maxAttempts && w.lastError,
      );
      if (stuck) {
        throw new Error(`write failed: ${stuck.lastError}`);
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for write to settle');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function requireCollection(
  model: ResourceModel,
  name: string,
): ManagedCollection {
  const collection = model.byName(name);
  if (!collection) {
    throw new Error(`Unknown collection "${name}"`);
  }
  return collection;
}

function bodyOf(record: Record<string, unknown>): string {
  return typeof record['body'] === 'string' ? record['body'] : '';
}

function stateOf(record: Record<string, unknown>): string {
  return typeof record['state'] === 'string' ? record['state'] : 'open';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The end of a link that lives on `system`, if any. */
function endFor(pair: { a: Link; b: Link }, system: string): Link | undefined {
  if (pair.a.system === system) return pair.a;
  if (pair.b.system === system) return pair.b;
  return undefined;
}

/** A stable key for a reflected pair, independent of side order. */
function pairKey(
  systemA: string,
  idA: string,
  systemB: string,
  idB: string,
): string {
  return [`${systemA}#${idA}`, `${systemB}#${idB}`].sort().join('|');
}
