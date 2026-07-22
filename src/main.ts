import { loadConfig } from './config/index.js';
import { buildDocument } from './sync/document.js';
import { deriveAuthProfile } from './oauth/oauth.js';
import { createApp } from './server/app.js';
import { SessionManager } from './server/session.js';
import { RemoteStorageManager } from './remotestorage/manager.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const document = await buildDocument(config);
  const profile = deriveAuthProfile(document);
  const remoteStorage = new RemoteStorageManager(
    config.remoteStorage.storePath,
    {
      module: config.remoteStorage.module,
      clientId: config.remoteStorage.clientId,
      redirectUri: config.remoteStorage.redirectUri,
    },
  );
  await remoteStorage.restore();
  const sessions = new SessionManager(config, document, profile, remoteStorage);
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
