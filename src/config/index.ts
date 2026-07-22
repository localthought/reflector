import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved relative to this compiled file (build/src/config). */
const repoRoot = resolve(here, '..', '..', '..');

export interface ReflectorConfig {
  port: number;
  /** Public origin the browser reaches this server on; used to build the OAuth redirect URI. */
  baseUrl: string;
  /**
   * OAuth *client* credentials — the only auth values that are deployment
   * secrets rather than properties of the API. Everything else about the flow
   * (endpoints, scopes, extra request parameters, the userinfo URL, and the
   * API base) is read from the OpenAPI document's security scheme and
   * `servers`, so there is nothing provider-specific here.
   */
  oauth: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  /** Directory the local-first JSON copy is written under (used when storage is local files). */
  dataDir: string;
  /** File the connected account's OAuth tokens are persisted to (survives restarts). */
  tokenStorePath: string;
  remoteStorage: {
    /** File a connected remoteStorage account is persisted to (survives restarts). */
    storePath: string;
    /** The storage module (top-level directory) Reflector reads and writes, e.g. `reflector`. */
    module: string;
    /** OAuth `client_id` presented to the remoteStorage provider (the app's origin). */
    clientId: string;
    /** OAuth `redirect_uri` the implicit-grant token is returned to. */
    redirectUri: string;
  };
  /** Absolute path to the vendored OpenAPI document the app is built around. */
  openApiPath: string;
  /** Directory holding the overlays applied to that document. */
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

export function loadConfig(): ReflectorConfig {
  const port = num('PORT', 3000);
  const baseUrl = env('BASE_URL', `http://localhost:${port}`);
  return {
    port,
    baseUrl,
    oauth: {
      // Generic names, with the historical Google-specific aliases kept as a
      // fallback so existing deployments keep working.
      clientId: env(
        'OAUTH_CLIENT_ID',
        env('GOOGLE_CALENDAR_CLIENT_ID', env('GOOGLE_CLIENT_ID')),
      ),
      clientSecret: env(
        'OAUTH_CLIENT_SECRET',
        env('GOOGLE_CALENDAR_CLIENT_SECRET', env('GOOGLE_CLIENT_SECRET')),
      ),
      redirectUri: env(
        'OAUTH_REDIRECT_URI',
        env('GOOGLE_REDIRECT_URI', `${baseUrl}/auth/callback`),
      ),
    },
    dataDir: resolve(env('DATA_DIR', resolve(repoRoot, 'data'))),
    tokenStorePath: resolve(
      env(
        'TOKEN_STORE_PATH',
        resolve(env('DATA_DIR', resolve(repoRoot, 'data')), 'tokens.json'),
      ),
    ),
    remoteStorage: {
      storePath: resolve(
        env(
          'REMOTESTORAGE_STORE_PATH',
          resolve(
            env('DATA_DIR', resolve(repoRoot, 'data')),
            'remotestorage.json',
          ),
        ),
      ),
      module: env('REMOTESTORAGE_MODULE', 'reflector'),
      clientId: env('REMOTESTORAGE_CLIENT_ID', baseUrl),
      redirectUri: env(
        'REMOTESTORAGE_REDIRECT_URI',
        `${baseUrl}/remotestorage/callback`,
      ),
    },
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
