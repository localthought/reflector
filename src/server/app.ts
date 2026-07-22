import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { ZipperConfig } from '../config/index.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchAccount,
  type AuthProfile,
} from '../oauth/oauth.js';
import { buildZip } from '../sync/zip.js';
import type { ActiveSession, SessionManager } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', '..', '..', 'public');

const SESSION_COOKIE = 'zipper_session';
const OAUTH_STATE_COOKIE = 'zipper_oauth_state';

// The document collections the calendar UI presents. These names are the app's
// own vocabulary for the resources declared in the CRUD-causality overlay; the
// engine resolves everything else (URLs, params, hierarchy) from the document.
const CALENDAR_COLLECTION = 'calendarList';
const EVENT_COLLECTION = 'events';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Wires up all HTTP routes: OAuth connect, full read, browse/edit, status, and ZIP download. */
export function createApp(
  config: ZipperConfig,
  sessions: SessionManager,
  profile: AuthProfile,
): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/assets', express.static(publicDir));

  const configured = (): boolean =>
    Boolean(config.oauth.clientId && config.oauth.clientSecret);

  const requireSession = (
    req: Request,
    res: Response,
  ): ActiveSession | undefined => {
    const session = sessions.authorized(readCookie(req, SESSION_COOKIE));
    if (!session) {
      res.status(401).json({ error: 'not_connected' });
      return undefined;
    }
    return session;
  };

  app.get('/', (_req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  // --- OAuth ---------------------------------------------------------------
  app.get('/auth/login', (_req, res) => {
    if (!configured()) {
      res
        .status(500)
        .send(
          'OAuth is not configured. Set OAUTH_CLIENT_ID and ' +
            'OAUTH_CLIENT_SECRET and restart.',
        );
      return;
    }
    const state = randomUUID();
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax' });
    res.redirect(buildAuthUrl(profile, config.oauth, state));
  });

  app.get(
    '/auth/callback',
    asyncRoute(async (req, res) => {
      const code =
        typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
      const state =
        typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
      const expected = readCookie(req, OAUTH_STATE_COOKIE);
      res.clearCookie(OAUTH_STATE_COOKIE);
      if (!code || !state || state !== expected) {
        res
          .status(400)
          .send('Invalid OAuth callback (state mismatch or missing code).');
        return;
      }
      const tokens = await exchangeCode(profile, config.oauth, code);
      const account = await fetchAccount(profile, tokens);
      const session = await sessions.connect(tokens, account);
      res.cookie(SESSION_COOKIE, session.sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      });
      res.redirect('/');
    }),
  );

  app.post(
    '/api/disconnect',
    asyncRoute(async (_req, res) => {
      await sessions.disconnect();
      res.clearCookie(SESSION_COOKIE);
      res.json({ ok: true });
    }),
  );

  app.get('/api/me', (req, res) => {
    const session = sessions.authorized(readCookie(req, SESSION_COOKIE));
    res.json({
      connected: Boolean(session),
      configured: configured(),
      account: session?.account ?? null,
      connectedAt: session?.connectedAt ?? null,
    });
  });

  // --- Full read -----------------------------------------------------------
  app.post(
    '/api/read',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const summary = await session.engine.fullRead();
      // Present the generic result in the calendar UI's terms.
      const calendars = summary.collections
        .filter((c) => c.collection === CALENDAR_COLLECTION)
        .reduce((sum, c) => sum + c.count, 0);
      const events = summary.collections
        .filter((c) => c.collection === EVENT_COLLECTION)
        .reduce((sum, c) => sum + c.count, 0);
      res.json({ calendars, events, ...summary });
    }),
  );

  // --- Browse & edit -------------------------------------------------------
  app.get(
    '/api/calendars',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json({ calendars: await session.engine.list(CALENDAR_COLLECTION) });
    }),
  );

  app.get(
    '/api/calendars/:calendarId/events',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json({
        events: await session.engine.list(EVENT_COLLECTION, {
          calendarId: req.params.calendarId,
        }),
      });
    }),
  );

  app.post(
    '/api/calendars/:calendarId/events',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const result = await session.engine.create(
        EVENT_COLLECTION,
        req.body as Record<string, unknown>,
        { calendarId: req.params.calendarId },
      );
      res.status(201).json(result);
    }),
  );

  app.patch(
    '/api/calendars/:calendarId/events/:eventId',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const result = await session.engine.update(
        EVENT_COLLECTION,
        req.params.eventId,
        req.body as Record<string, unknown>,
        { calendarId: req.params.calendarId },
      );
      res.json(result);
    }),
  );

  app.delete(
    '/api/calendars/:calendarId/events/:eventId',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json(
        await session.engine.remove(EVENT_COLLECTION, req.params.eventId, {
          calendarId: req.params.calendarId,
        }),
      );
    }),
  );

  // --- Sync status ---------------------------------------------------------
  app.get('/api/status', (req, res) => {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }
    const status = session.engine.status();
    // The UI keys sync badges by event id; expose the generic record id as such.
    res.json({
      ...status,
      changes: status.changes.map((change) => ({
        ...change,
        eventId: change.id,
      })),
    });
  });

  // --- ZIP download --------------------------------------------------------
  app.get(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const buffer = await buildZip(config.dataDir);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="zipper-export-${stamp}.zip"`,
      );
      res.send(buffer);
    }),
  );

  return app;
}
