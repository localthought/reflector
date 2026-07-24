import { loadConfig } from './config/index.js';
import { buildDocument } from './sync/document.js';
import { deriveAuthProfile } from './oauth/oauth.js';
import { createApp } from './server/app.js';
import { SessionManager } from './server/session.js';
import { FileUserStore, type UserStore } from './server/user-store.js';
import { PostgresUserStore } from './server/user-store-postgres.js';
import { RemoteStorageManager } from './remotestorage/manager.js';
import type { ReflectorConfig } from './config/index.js';

/**
 * Picks where connected users are persisted: Postgres when `DATABASE_URL` is
 * set (durable on ephemeral hosts), otherwise per-user files on disk. Existing
 * single-user `tokens.json` / `remotestorage.json` are migrated into the file
 * store on first load.
 */
async function createUserStore(config: ReflectorConfig): Promise<UserStore> {
  if (config.databaseUrl) {
    const store = await PostgresUserStore.create(config.databaseUrl);
    await store.init();
    console.log('Reflector: persisting users in Postgres.');
    return store;
  }
  return new FileUserStore(config.usersDir, {
    tokenPath: config.tokenStorePath,
    remoteStoragePath: config.remoteStorage.storePath,
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const document = await buildDocument(config);
  const profile = deriveAuthProfile(document);
  const remoteStorage = new RemoteStorageManager({
    module: config.remoteStorage.module,
    clientId: config.remoteStorage.clientId,
    redirectUri: config.remoteStorage.redirectUri,
  });
  const userStore = await createUserStore(config);
  const sessions = new SessionManager(
    config,
    document,
    profile,
    remoteStorage,
    userStore,
  );
  await sessions.restore();

  const app = createApp(config, sessions, profile, remoteStorage);
  app.listen(config.port, () => {
    console.log(`Reflector listening on ${config.baseUrl}`);
    if (!config.oauth.clientId || !config.oauth.clientSecret) {
      console.warn(
        'Warning: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set; ' +
          'the "Connect" flow will not work until they are.',
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start Reflector:', error);
  process.exit(1);
});
