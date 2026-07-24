import { generateId } from '../src/sync/resources.js';
import {
  buildEventsClient,
  drainWrites,
  eventsModel,
  sleep,
} from './events-client.js';
import { FakePlatform, type PlatformRecord } from './fake-platform.js';

/** The private extendedProperties key each driven event is tagged with. */
const RUN_MARKER = 'reflectorRunId';

/** What a test wants driven onto the source platform (id + marker are added). */
export interface EventInput {
  summary: string;
  start: Record<string, unknown>;
  end: Record<string, unknown>;
}

/** Reads the run marker off an event, if present. */
export function markerOf(event: PlatformRecord): string | undefined {
  const ext = event['extendedProperties'] as
    | { private?: Record<string, unknown> }
    | undefined;
  const value = ext?.private?.[RUN_MARKER];
  return typeof value === 'string' ? value : undefined;
}

/** Merges the run marker into an event's extendedProperties, preserving others. */
function withMarker(event: PlatformRecord, runId: string): PlatformRecord {
  const ext = (event['extendedProperties'] as Record<string, unknown>) ?? {};
  const priv = (ext['private'] as Record<string, unknown>) ?? {};
  return {
    ...event,
    extendedProperties: { ...ext, private: { ...priv, [RUN_MARKER]: runId } },
  };
}

/** Deletes every run-tagged record from a calendar on a platform (teardown). */
export function cleanupTagged(
  platform: FakePlatform,
  calendarId: string,
  runId: string,
): void {
  for (const event of platform.events(calendarId)) {
    if (markerOf(event) === runId) {
      platform.deleteDirect(calendarId, String(event['id']));
    }
  }
}

/**
 * Drives data changes into the source platform, using syncables directly (not
 * the app's SyncEngine). Every event is tagged with the run id so the reviewer
 * and teardown can find exactly this run's records.
 */
export class Driver {
  constructor(
    private readonly platform: FakePlatform,
    private readonly calendarId: string,
  ) {}

  /** Creates the events and waits until they've actually landed on the platform. */
  async create(events: EventInput[], runId: string): Promise<PlatformRecord[]> {
    const model = await eventsModel();
    const { client, resource } = await buildEventsClient(
      this.platform.fetchFor(this.calendarId),
    );
    const created: PlatformRecord[] = [];
    for (const input of events) {
      const id = model.generatesId ? generateId(model.idPattern) : undefined;
      const payload = withMarker(
        id !== undefined ? { ...input, id } : { ...input },
        runId,
      );
      created.push(await client.create(resource, payload));
    }
    // Wait for the background POSTs to settle, so the source really holds them
    // before the reflector reads it.
    await drainWrites(client, resource);
    return created;
  }
}

/**
 * The independent observer. Reads the target platform through fresh syncables
 * clients (fresh in-memory copy each poll, so it never trusts cached state)
 * and waits for the reflected records to appear.
 *
 * Note: reading through syncables means the reviewer shares syncables' read
 * path with the SUT. For a stronger, fully independent oracle, read the target
 * via its raw API instead — swap the body of `readTagged`.
 */
export class Reviewer {
  constructor(
    private readonly platform: FakePlatform,
    private readonly calendarId: string,
  ) {}

  /** Polls until at least `expected` run-tagged records are visible, or timeout. */
  async awaitReflected(
    runId: string,
    expected: number,
    opts: { timeoutMs: number; intervalMs: number },
  ): Promise<PlatformRecord[]> {
    const deadline = Date.now() + opts.timeoutMs;
    let seen: PlatformRecord[] = [];
    for (;;) {
      seen = await this.readTagged(runId);
      if (seen.length >= expected || Date.now() >= deadline) {
        return seen;
      }
      await sleep(opts.intervalMs);
    }
  }

  private async readTagged(runId: string): Promise<PlatformRecord[]> {
    const { client, resource } = await buildEventsClient(
      this.platform.fetchFor(this.calendarId),
    );
    await client.sync();
    const all = await client.list(resource);
    return all.filter((e) => markerOf(e) === runId);
  }
}

/** A reflection transform: how a source record should appear on the target. */
export type Mapping = (source: PlatformRecord) => PlatformRecord;

/** The correct Calendar→Calendar mapping: carry the content + marker, drop the source id. */
export const identityMapping: Mapping = (source) => ({
  summary: source['summary'],
  start: source['start'],
  end: source['end'],
  extendedProperties: source['extendedProperties'],
});

export interface StubReflectorOptions {
  source: FakePlatform;
  sourceCalendar: string;
  target: FakePlatform;
  targetCalendar: string;
  /** How the reflector maps a source record to the target. Defaults to identity. */
  mapping?: Mapping;
  /** Delay before the reflection is applied, simulating async SUT processing. */
  reflectDelayMs?: number;
}

/**
 * Stands in for the system under test: a separate Reflector instance that
 * reflects the source platform onto the target. `reflectNow()` is the seam —
 * replace it with a trigger to the real SUT's "reflect now" endpoint.
 *
 * Like a real reflector it reads the source and writes the target through
 * syncables; it does NOT share the oracle's notion of correctness (its
 * `mapping` is its own implementation), so a wrong mapping is a real bug the
 * reviewer must catch.
 */
export class StubReflector {
  readonly targetPlatform: FakePlatform;
  readonly targetCalendarId: string;
  private readonly mapping: Mapping;
  private readonly delayMs: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StubReflectorOptions) {
    this.targetPlatform = opts.target;
    this.targetCalendarId = opts.targetCalendar;
    this.mapping = opts.mapping ?? identityMapping;
    this.delayMs = opts.reflectDelayMs ?? 0;
  }

  /** Triggers reflection of this run's records and returns immediately. */
  reflectNow(runId: string): void {
    this.pending = this.pending.then(() => this.reflect(runId));
  }

  /** Resolves once any in-flight reflection has finished (for teardown). */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async reflect(runId: string): Promise<void> {
    if (this.delayMs) {
      await sleep(this.delayMs);
    }
    const read = await buildEventsClient(
      this.opts.source.fetchFor(this.opts.sourceCalendar),
    );
    await read.client.sync();
    const sourceEvents = await read.client.list(read.resource);

    const write = await buildEventsClient(
      this.opts.target.fetchFor(this.opts.targetCalendar),
    );
    for (const event of sourceEvents) {
      if (markerOf(event) !== runId) {
        continue; // only this run's records; a real reflector detects changes
      }
      await write.client.create(write.resource, this.mapping(event));
    }
    await drainWrites(write.client, write.resource);
  }
}
