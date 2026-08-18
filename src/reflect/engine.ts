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
import type { IdMap } from './id-map.js';

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
}

/** What one `reflect()` run did, per direction. */
export interface ReflectionSummary {
  /** Records newly copied, as `{ kind, from, to }`. */
  created: { kind: string; from: string; to: string }[];
  errors: { kind: string; from: string; error: string }[];
}

const DEFAULT_RETRY = { baseDelayMs: 200, maxDelayMs: 4000, maxAttempts: 5 };

/**
 * Reflects records between two systems. This core handles **issues**: it copies
 * each original issue from one side to the other, embedding a hidden marker
 * that links the copy back to its source, and it never reflects a copy onward
 * (echo suppression) nor twice (idempotency, via the {@link IdMap} plus a scan
 * of the destination's existing markers so it is robust even if the map is
 * empty). Open/closed state and comments are layered on in follow-ups (#27,
 * #28); this file is the create-reflection foundation from #25.
 *
 * It is built on the syncables client the app already uses — one client per
 * side per collection — so it does no syncing of its own.
 */
export class ReflectionEngine {
  private readonly direction: 'bidirectional' | 'a-to-b';
  private readonly retry: NonNullable<ReflectionOptions['retry']>;
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly a: ReflectionSide,
    private readonly b: ReflectionSide,
    private readonly idMap: IdMap,
    options: ReflectionOptions = {},
  ) {
    this.direction = options.direction ?? 'bidirectional';
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 15_000;
  }

  /** Runs one reflection pass (A→B, and B→A unless one-way). */
  async reflect(): Promise<ReflectionSummary> {
    const summary: ReflectionSummary = { created: [], errors: [] };
    await this.reflectIssues(this.a, this.b, summary);
    if (this.direction === 'bidirectional') {
      await this.reflectIssues(this.b, this.a, summary);
    }
    return summary;
  }

  private clientFor(
    side: ReflectionSide,
    collectionName: string,
  ): { client: ApiClient; collection: ManagedCollection } {
    const collection = requireCollection(side.model, collectionName);
    const client = createApiClient(
      subsetDocument(side.document, collection.paths),
      {
        baseUrl: SYNCABLES_BASE_URL,
        fetch: side.auth.authorizedFetch(side.context),
        identityField: collection.idField,
        retry: this.retry,
      },
    );
    return { client, collection };
  }

  private async reflectIssues(
    from: ReflectionSide,
    to: ReflectionSide,
    summary: ReflectionSummary,
  ): Promise<void> {
    const src = this.clientFor(from, 'issues');
    const dst = this.clientFor(to, 'issues');
    await src.client.sync();
    await dst.client.sync();

    const sources = await src.client.list(src.collection.collectionUrl);
    const destIssues = await dst.client.list(dst.collection.collectionUrl);

    // Existing copies on the destination, keyed by the source id their marker
    // names — so a lost/empty id-map doesn't cause duplicate reflections.
    const existing = new Map<string, string>();
    for (const issue of destIssues) {
      const marker = parseMarker(bodyOf(issue));
      if (marker && marker.kind === 'issue' && marker.system === from.system) {
        existing.set(marker.id, String(issue[dst.collection.idField]));
      }
    }

    for (const issue of sources) {
      const id = String(issue[src.collection.idField]);
      const marker = parseMarker(bodyOf(issue));
      // Echo: this issue is itself a copy of a `to`-side record; reflecting it
      // back would loop. (A record whose marker names some third system, or no
      // marker at all, is an original here and is reflected.)
      if (marker && marker.system === to.system) {
        continue;
      }
      // Already reflected (persisted map, or an existing destination copy).
      const known =
        this.idMap.counterpart('issue', from.system, id) ??
        (existing.has(id)
          ? { system: to.system, id: existing.get(id)! }
          : undefined);
      if (known) {
        // Repair the persisted map if it was the destination scan that knew.
        await this.idMap.link(
          'issue',
          { system: from.system, id },
          { system: to.system, id: known.id },
        );
        continue;
      }

      try {
        const toId = await this.createIssueCopy(from, dst, issue, id);
        await this.idMap.link(
          'issue',
          { system: from.system, id },
          { system: to.system, id: toId },
        );
        summary.created.push({
          kind: 'issue',
          from: `${from.system}#${id}`,
          to: `${to.system}#${toId}`,
        });
      } catch (error) {
        summary.errors.push({
          kind: 'issue',
          from: `${from.system}#${id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Creates a marked copy of `issue` on the destination and returns its new id. */
  private async createIssueCopy(
    from: ReflectionSide,
    dst: { client: ApiClient; collection: ManagedCollection },
    issue: Record<string, unknown>,
    sourceId: string,
  ): Promise<string> {
    const body = embedMarker(stripMarker(bodyOf(issue)), {
      system: from.system,
      kind: 'issue',
      id: sourceId,
    });
    const title = typeof issue['title'] === 'string' ? issue['title'] : '';
    await dst.client.create(dst.collection.collectionUrl, { title, body });
    await this.drain(dst.client, dst.collection.collectionUrl);

    // After the POST settles, find our copy by its unique marker and read the
    // server-assigned id off it.
    const copies = await dst.client.list(dst.collection.collectionUrl);
    const copy = copies.find((c) => {
      const marker = parseMarker(bodyOf(c));
      return (
        marker?.kind === 'issue' &&
        marker.system === from.system &&
        marker.id === sourceId
      );
    });
    if (!copy) {
      throw new Error('created copy not found after write settled');
    }
    return String(copy[dst.collection.idField]);
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
