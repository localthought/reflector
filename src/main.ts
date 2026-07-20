import { loadConfig } from './config/index.js';
import { buildCalendarDocument } from './sync/document.js';
import { createApp } from './server/app.js';
import { SessionManager } from './server/session.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const document = await buildCalendarDocument(config);
  const sessions = new SessionManager(config, document);
  await sessions.restore();

  const app = createApp(config, sessions);
  app.listen(config.port, () => {
    console.log(`Zipper listening on ${config.baseUrl}`);
    if (!config.google.clientId || !config.google.clientSecret) {
      console.warn(
        'Warning: GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET are not set; ' +
          'the "Connect Google" flow will not work until they are.',
      );
    }
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start Zipper:', error);
  process.exit(1);
});
