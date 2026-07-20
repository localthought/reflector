import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved relative to this compiled file (build/src/config). */
const repoRoot = resolve(here, '..', '..', '..');

export interface ZipperConfig {
  port: number;
  /** Public origin the browser reaches this server on; used to build the OAuth redirect URI. */
  baseUrl: string;
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** OAuth scopes requested. Calendar read/write plus the user's email for display. */
    scopes: string[];
    /** Root of the real Google API, e.g. https://www.googleapis.com/calendar/v3. */
    apiBase: string;
    authEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
  };
  /** Directory the local-first JSON copy is written under. This is what the ZIP download packages. */
  dataDir: string;
  /** File the connected account's OAuth tokens are persisted to (survives restarts). */
  tokenStorePath: string;
  /** Absolute path to the vendored Google Calendar OpenAPI document. */
  openApiPath: string;
  /** Directory holding the localthought/overlays Calendar overlays. */
  overlayDir: string;
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    /** After this many failed attempts a write gives up, which triggers a local rollback. */
    maxAttempts: number;
  };
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): ZipperConfig {
  const port = num('PORT', 3000);
  const baseUrl = env('BASE_URL', `http://localhost:${port}`);
  return {
    port,
    baseUrl,
    google: {
      // Primary names requested for deployment; the shorter aliases are kept
      // as a fallback for convenience.
      clientId: env('GOOGLE_CALENDAR_CLIENT_ID', env('GOOGLE_CLIENT_ID')),
      clientSecret: env(
        'GOOGLE_CALENDAR_CLIENT_SECRET',
        env('GOOGLE_CLIENT_SECRET'),
      ),
      redirectUri: env(
        'GOOGLE_REDIRECT_URI',
        `${baseUrl}/auth/google/callback`,
      ),
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email',
        'openid',
      ],
      apiBase: env('GOOGLE_API_BASE', 'https://www.googleapis.com/calendar/v3'),
      authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    },
    dataDir: resolve(env('DATA_DIR', resolve(repoRoot, 'data'))),
    tokenStorePath: resolve(
      env(
        'TOKEN_STORE_PATH',
        resolve(env('DATA_DIR', resolve(repoRoot, 'data')), 'tokens.json'),
      ),
    ),
    openApiPath: resolve(
      env(
        'OPENAPI_PATH',
        resolve(repoRoot, 'spec/google-calendar-v3.openapi.yaml'),
      ),
    ),
    overlayDir: resolve(env('OVERLAY_DIR', resolve(repoRoot, 'spec/overlays'))),
    retry: {
      baseDelayMs: num('SYNC_RETRY_BASE_MS', 400),
      maxDelayMs: num('SYNC_RETRY_MAX_MS', 8000),
      maxAttempts: num('SYNC_RETRY_MAX_ATTEMPTS', 5),
    },
  };
}
