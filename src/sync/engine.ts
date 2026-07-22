import { randomBytes, randomUUID } from 'node:crypto';
import {
  createApiClient,
  type ApiClient,
  type OpenApiDocument,
  type StorageAdapter,
} from 'syncables';
import type { ZipperConfig } from '../config/index.js';
import {
  SYNCABLES_BASE_URL,
  type TokenManager,
} from '../google/authed-fetch.js';
import {
  FileStorageBackend,
  type ExportRecord,
  type StorageBackend,
} from './storage.js';
import {
  CALENDAR_LIST_COLLECTION,
  CALENDAR_LIST_PATHS,
  EVENTS_COLLECTION,
  EVENT_PATHS,
  subsetDocument,
} from './document.js';

export type ChangeType = 'create' | 'update' | 'delete';
export type ChangeState = 'syncing' | 'synced' | 'failed';

/** A single local-first edit and how far its background sync to Google has got. */
export interface ChangeRecord {
  changeId: string;
  calendarId: string;
  eventId: string;
  type: ChangeType;
  state: ChangeState;
  summary: string;
  startedAt: number;
  settledAt?: number;
  error?: string;
}

export interface FullReadSummary {
  calendars: number;
  events: number;
  perCalendar: { calendarId: string; summary: string; events: number }[];
}

interface EventsClient {
  client: ApiClient;
  storage: StorageAdapter;
}

const EVENT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv'; // base32hex, per Google's id rules

/** Generates an event id that satisfies Google Calendar's base32hex id rules. */
export function generateEventId(): string {
  const bytes = randomBytes(26);
  let id = '';
  for (const byte of bytes) {
    id += EVENT_ID_ALPHABET[byte % EVENT_ID_ALPHABET.length];
  }
  return id;
}

/**
 * Orchestrates the whole local-first flow for one connected account, using
 * syncables as the sync engine: a full read into a local JSON copy, browsing
 * that copy, and local-first create/update/delete whose background sync to
 * Google is tracked so the UI can show "syncing" / "synced" / a rollback.
 */
export class SyncEngine {
  private readonly calendarList: EventsClient;
  private readonly events = new Map<string, EventsClient>();
  private readonly changes: ChangeRecord[] = [];
  private readonly snapshots = new Map<
    string,
    Record<string, unknown> | undefined
  >();
  private watcher: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: ZipperConfig,
    private readonly document: OpenApiDocument,
    private readonly tokens: TokenManager,
    /**
     * Where the local-first copy lives. Defaults to on-disk files; a
     * connected remoteStorage account swaps in its own backend instead.
     */
    private readonly backend: StorageBackend = new FileStorageBackend(
      config.dataDir,
    ),
  ) {
    this.calendarList = this.makeClient(CALENDAR_LIST_PATHS, '_account', {});
  }

  private makeClient(
    paths: string[],
    namespace: string,
    pathParams: Record<string, string>,
  ): EventsClient {
    const storage = this.backend.adapter(namespace);
    const client = createApiClient(subsetDocument(this.document, paths), {
      baseUrl: SYNCABLES_BASE_URL,
      storage,
      fetch: this.tokens.authorizedFetch(pathParams),
      retry: {
        baseDelayMs: this.config.retry.baseDelayMs,
        maxDelayMs: this.config.retry.maxDelayMs,
        maxAttempts: this.config.retry.maxAttempts,
      },
    });
    return { client, storage };
  }

  private eventsClient(calendarId: string): EventsClient {
    let existing = this.events.get(calendarId);
    if (!existing) {
      existing = this.makeClient(EVENT_PATHS, calendarId, { calendarId });
      this.events.set(calendarId, existing);
    }
    return existing;
  }

  /** Reads the full dataset Google has for the account into the local copy. */
  async fullRead(): Promise<FullReadSummary> {
    await this.calendarList.client.sync();
    const calendars = await this.calendarList.client.list(
      CALENDAR_LIST_COLLECTION,
    );
    const perCalendar: FullReadSummary['perCalendar'] = [];
    let total = 0;
    for (const calendar of calendars) {
      const calendarId = String(calendar['id']);
      const { client } = this.eventsClient(calendarId);
      await client.sync();
      const events = await client.list(EVENTS_COLLECTION);
      total += events.length;
      perCalendar.push({
        calendarId,
        summary: String(calendar['summary'] ?? calendarId),
        events: events.length,
      });
    }
    return { calendars: calendars.length, events: total, perCalendar };
  }

  async listCalendars(): Promise<Record<string, unknown>[]> {
    return this.calendarList.client.list(CALENDAR_LIST_COLLECTION);
  }

  async listEvents(calendarId: string): Promise<Record<string, unknown>[]> {
    return this.eventsClient(calendarId).client.list(EVENTS_COLLECTION);
  }

  async getEvent(
    calendarId: string,
    eventId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.eventsClient(calendarId).client.get(EVENTS_COLLECTION, eventId);
  }

  async createEvent(
    calendarId: string,
    data: Record<string, unknown>,
  ): Promise<{ event: Record<string, unknown>; change: ChangeRecord }> {
    const { client } = this.eventsClient(calendarId);
    const id =
      typeof data['id'] === 'string' && data['id']
        ? data['id']
        : generateEventId();
    const event = await client.create(EVENTS_COLLECTION, { ...data, id });
    const change = this.track(calendarId, id, 'create', event, undefined);
    return { event, change };
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    data: Record<string, unknown>,
  ): Promise<{ event: Record<string, unknown>; change: ChangeRecord }> {
    const { client } = this.eventsClient(calendarId);
    const before = await client.get(EVENTS_COLLECTION, eventId);
    const event = await client.update(EVENTS_COLLECTION, eventId, data);
    const change = this.track(calendarId, eventId, 'update', event, before);
    return { event, change };
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ change: ChangeRecord }> {
    const { client } = this.eventsClient(calendarId);
    const before = await client.get(EVENTS_COLLECTION, eventId);
    await client.remove(EVENTS_COLLECTION, eventId);
    const change = this.track(
      calendarId,
      eventId,
      'delete',
      before ?? {},
      before,
    );
    return { change };
  }

  private track(
    calendarId: string,
    eventId: string,
    type: ChangeType,
    value: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
  ): ChangeRecord {
    const change: ChangeRecord = {
      changeId: randomUUID(),
      calendarId,
      eventId,
      type,
      state: 'syncing',
      summary: String(value['summary'] ?? before?.['summary'] ?? eventId),
      startedAt: Date.now(),
    };
    this.changes.unshift(change);
    this.snapshots.set(change.changeId, before);
    this.ensureWatcher();
    return change;
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = setInterval(() => {
      void this.pollChanges();
    }, 250);
    if (typeof this.watcher.unref === 'function') {
      this.watcher.unref();
    }
  }

  /**
   * Advances every in-flight change by inspecting the syncables write queue:
   * a write that has left the queue succeeded; one that has exhausted its
   * retries failed, so its local edit is rolled back to the pre-edit snapshot.
   */
  private async pollChanges(): Promise<void> {
    const active = this.changes.filter((change) => change.state === 'syncing');
    for (const change of active) {
      const { client, storage } = this.eventsClient(change.calendarId);
      const pending = client
        .pendingWrites(EVENTS_COLLECTION)
        .find(
          (write) => write.id === change.eventId && write.type === change.type,
        );

      if (!pending) {
        change.state = 'synced';
        change.settledAt = Date.now();
        this.snapshots.delete(change.changeId);
        continue;
      }
      const gaveUp =
        pending.lastError !== undefined &&
        pending.attempts >= this.config.retry.maxAttempts;
      if (gaveUp) {
        await this.rollback(change, storage);
        change.state = 'failed';
        change.error = pending.lastError ?? 'sync failed';
        change.settledAt = Date.now();
        this.snapshots.delete(change.changeId);
      }
    }
    if (
      !this.changes.some((change) => change.state === 'syncing') &&
      this.watcher
    ) {
      clearInterval(this.watcher);
      this.watcher = undefined;
    }
  }

  private async rollback(
    change: ChangeRecord,
    storage: StorageAdapter,
  ): Promise<void> {
    const before = this.snapshots.get(change.changeId);
    if (change.type === 'create') {
      await storage.delete(EVENTS_COLLECTION, change.eventId);
    } else if (before) {
      await storage.put(EVENTS_COLLECTION, change.eventId, before);
    } else {
      await storage.delete(EVENTS_COLLECTION, change.eventId);
    }
  }

  /** Every record in the active storage backend, for the ZIP download. */
  async exportRecords(): Promise<ExportRecord[]> {
    return this.backend.enumerate();
  }

  /** Where this engine's local-first copy lives, for display in the UI. */
  storageLabel(): string {
    return this.backend.label;
  }

  /** Snapshot of sync status for the UI: how many edits are in flight and their history. */
  status(): { syncing: number; failed: number; changes: ChangeRecord[] } {
    const syncing = this.changes.filter((c) => c.state === 'syncing').length;
    const failed = this.changes.filter((c) => c.state === 'failed').length;
    return { syncing, failed, changes: this.changes.slice(0, 50) };
  }

  /** Waits until no edits are in flight (used by tests and graceful shutdown). */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.changes.some((c) => c.state === 'syncing') &&
      Date.now() < deadline
    ) {
      await this.pollChanges();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
