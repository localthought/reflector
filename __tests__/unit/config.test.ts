import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const ENV_KEYS = ['BASE_URL', 'PORT', 'HEROKU_APP_DEFAULT_DOMAIN_NAME'];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

describe('loadConfig baseUrl', () => {
  it('uses BASE_URL when set', () => {
    process.env.BASE_URL = 'https://example.com';
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    expect(loadConfig().baseUrl).toBe('https://example.com');
  });

  it('falls back to the Heroku default domain when BASE_URL is unset', () => {
    delete process.env.BASE_URL;
    process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME =
      'reflector-prod-8e1e64ecb238.herokuapp.com';
    expect(loadConfig().baseUrl).toBe(
      'https://reflector-prod-8e1e64ecb238.herokuapp.com',
    );
  });

  it('falls back to localhost when neither is set', () => {
    delete process.env.BASE_URL;
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    process.env.PORT = '4321';
    expect(loadConfig().baseUrl).toBe('http://localhost:4321');
  });

  it('derives the OAuth redirect URI from the resolved baseUrl', () => {
    delete process.env.BASE_URL;
    process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME = 'example.herokuapp.com';
    expect(loadConfig().oauth.redirectUri).toBe(
      'https://example.herokuapp.com/auth/callback',
    );
  });

  it('strips a trailing slash from BASE_URL so callback URLs are not doubled', () => {
    process.env.BASE_URL = 'https://example.com/';
    delete process.env.HEROKU_APP_DEFAULT_DOMAIN_NAME;
    const config = loadConfig();
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.oauth.redirectUri).toBe('https://example.com/auth/callback');
  });
});
