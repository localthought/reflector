import type { ZipperConfig } from '../config/index.js';

/** OAuth token set persisted for a connected Google account. */
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

export interface GoogleAccount {
  email?: string;
  sub?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/** Builds the Google consent-screen URL the user is redirected to when connecting. */
export function buildAuthUrl(config: ZipperConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: config.google.scopes.join(' '),
    // `offline` + `consent` guarantees a refresh_token so we can keep syncing
    // after the short-lived access token expires.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${config.google.authEndpoint}?${params.toString()}`;
}

function toTokens(body: TokenResponse, previous?: GoogleTokens): GoogleTokens {
  // A refresh only returns a new refresh_token occasionally; keep the old one.
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  const scope = body.scope ?? previous?.scope;
  const tokenType = body.token_type ?? previous?.tokenType;
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...(refreshToken ? { refreshToken } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

/** Exchanges the OAuth `code` from the callback for an access/refresh token set. */
export async function exchangeCode(
  config: ZipperConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  const response = await fetchImpl(config.google.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
      code,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Google token exchange failed with status ${response.status}: ${await response.text()}`,
    );
  }
  return toTokens((await response.json()) as TokenResponse);
}

/** Refreshes an expired access token using the stored refresh token. */
export async function refreshTokens(
  config: ZipperConfig,
  tokens: GoogleTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  if (!tokens.refreshToken) {
    throw new Error(
      'Cannot refresh Google access token: no refresh token stored.',
    );
  }
  const response = await fetchImpl(config.google.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Google token refresh failed with status ${response.status}: ${await response.text()}`,
    );
  }
  return toTokens((await response.json()) as TokenResponse, tokens);
}

/** Fetches the connected account's email/subject for display in the UI. */
export async function fetchAccount(
  config: ZipperConfig,
  tokens: GoogleTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleAccount> {
  const response = await fetchImpl(config.google.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) {
    return {};
  }
  const body = (await response.json()) as { email?: string; sub?: string };
  return {
    ...(body.email ? { email: body.email } : {}),
    ...(body.sub ? { sub: body.sub } : {}),
  };
}
