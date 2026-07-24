import { randomUUID } from 'node:crypto';
import type { FakePlatform, PlatformRecord } from './fake-platform.js';
import {
  cleanupTagged,
  type Driver,
  type EventInput,
  type Reviewer,
  type StubReflector,
} from './roles.js';

/** Fields the oracle treats as "the content that must be reflected". */
const COMPARED_FIELDS = ['summary', 'start', 'end'] as const;

/**
 * The correctness oracle. Deliberately independent of the reflector's own
 * mapping: it checks that every source record has a matching reflected record
 * on the compared fields, and that no extra ones appeared.
 */
export function compareReflection(
  source: PlatformRecord[],
  reflected: PlatformRecord[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (reflected.length !== source.length) {
    problems.push(
      `expected ${source.length} reflected record(s), saw ${reflected.length}`,
    );
  }
  for (const src of source) {
    const match = reflected.find((r) =>
      COMPARED_FIELDS.every((f) => deepEqual(r[f], src[f])),
    );
    if (!match) {
      problems.push(
        `no reflected record matches source "${String(src['summary'])}" on ${COMPARED_FIELDS.join('/')}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

export type ReflectionOutcome =
  | { status: 'reflected'; reflected: PlatformRecord[] }
  | { status: 'mismatch'; problems: string[]; reflected: PlatformRecord[] }
  | { status: 'timeout'; seen: number; expected: number };

export interface Scenario {
  driver: Driver;
  reviewer: Reviewer;
  reflector: StubReflector;
  /** Where the driver writes (needed for teardown of the source side). */
  sourcePlatform: FakePlatform;
  sourceCalendar: string;
  events: EventInput[];
  poll?: { timeoutMs?: number; intervalMs?: number };
}

/**
 * One end-to-end reflection test: drive changes into the source, kick the
 * system under test, wait for the reviewer to observe the result, judge it,
 * and clean up both platforms — all in this one process.
 */
export async function runReflectionScenario(
  s: Scenario,
): Promise<ReflectionOutcome> {
  const runId = `run-${randomUUID()}`;
  const timeoutMs = s.poll?.timeoutMs ?? 3_000;
  const intervalMs = s.poll?.intervalMs ?? 50;

  try {
    // 1. drive changes into the source (awaits them landing on the platform)
    const created = await s.driver.create(s.events, runId);

    // 2. kick the system under test
    s.reflector.reflectNow(runId);

    // 3. wait for the reviewer to observe the reflection on the target
    const reflected = await s.reviewer.awaitReflected(runId, created.length, {
      timeoutMs,
      intervalMs,
    });

    // 4. judge: not-enough-in-time vs wrong vs correct
    if (reflected.length < created.length) {
      return {
        status: 'timeout',
        seen: reflected.length,
        expected: created.length,
      };
    }
    const verdict = compareReflection(created, reflected);
    return verdict.ok
      ? { status: 'reflected', reflected }
      : { status: 'mismatch', problems: verdict.problems, reflected };
  } finally {
    // 5. cleanup — let any in-flight reflection finish, then drop this run's
    // records from both platforms so runs don't contaminate each other.
    await s.reflector.idle().catch(() => undefined);
    cleanupTagged(s.sourcePlatform, s.sourceCalendar, runId);
    cleanupTagged(
      s.reflector.targetPlatform,
      s.reflector.targetCalendarId,
      runId,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
