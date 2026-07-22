import { loadConfig } from './config/index.js';
import { buildDocument } from './sync/document.js';
import { deriveAuthProfile } from './oauth/oauth.js';
import { createApp } from './server/app.js';
import { SessionManager } from './server/session.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const document = await buildDocument(config);
  const profile = deriveAuthProfile(document);
  const sessions = new SessionManager(config, document, profile);
  await sessions.restore();

  const app = createApp(config, sessions, profile);
  app.listen(config.port, () => {
    console.log(`Zipper listening on ${config.baseUrl}`);
    if (!config.oauth.clientId || !config.oauth.clientSecret) {
      console.warn(
        'Warning: OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set; ' +
          'the "Connect" flow will not work until they are.',
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start Zipper:', error);
  process.exit(1);
});
