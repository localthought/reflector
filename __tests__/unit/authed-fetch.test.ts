import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { SYNCABLES_BASE_URL, TokenManager } from '../../src/google/authed-fetch.js';
import type { GoogleTokens } from '../../src/google/oauth.js';

const config = loadConfig();

function freshTokens(): GoogleTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3_600_000,
  };
}

describe('TokenManager.authorizedFetch', () => {
  it('retargets to the Google API base, fills path params, and adds a bearer token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), auth: headers.get('Authorization') });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const manager = new TokenManager(config, freshTokens(), fakeFetch);
    const fetchImpl = manager.authorizedFetch({ calendarId: 'user@example.com' });

    // The URL syncables would build for the events collection (braces encoded).
    await fetchImpl(`${SYNCABLES_BASE_URL}/calendars/%7BcalendarId%7D/events?maxResults=250`);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/user%40example.com/events?maxResults=250',
    );
    expect(seen[0]?.auth).toBe('Bearer access-1');
  });

  it('refreshes the access token once on a 401 and retries', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === config.google.tokenEndpoint) {
        return new Response(
          JSON.stringify({ access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200 },
        );
      }
      calls += 1;
      return new Response('{}', { status: calls === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const manager = new TokenManager(config, freshTokens(), fakeFetch);
    const fetchImpl = manager.authorizedFetch({ calendarId: 'primary' });
    const response = await fetchImpl(`${SYNCABLES_BASE_URL}/calendars/primary/events`);

    expect(response.status).toBe(200);
    expect(manager.current().accessToken).toBe('access-2');
  });
});
