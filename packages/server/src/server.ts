import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { IndexDatabase } from '@backstory/core';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { createApi } from './api.js';

export interface ExplorerOptions {
  db: IndexDatabase;
  /** Directory holding the prebuilt explorer. */
  uiDir: string;
  port?: number;
  host?: string;
}

export interface RunningExplorer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function createExplorerApp(options: Pick<ExplorerOptions, 'db' | 'uiDir'>): Hono {
  const app = new Hono();

  app.route('/', createApi({ db: options.db }));

  if (existsSync(options.uiDir)) {
    app.use('/assets/*', serveStatic({ root: options.uiDir }));
    // Any non-API path serves the app shell, so a deep link still loads.
    app.get('*', serveStatic({ path: 'index.html', root: options.uiDir }));
  } else {
    app.get('*', (c) =>
      c.text('The explorer bundle is missing from this install. The API is still available.', 500),
    );
  }

  return app;
}

/**
 * Starts the explorer on the loopback interface only.
 *
 * Binding to localhost is a deliberate boundary rather than a default: the
 * records describe private work, and nothing about this needs to be reachable
 * from another machine.
 */
export async function startExplorer(options: ExplorerOptions): Promise<RunningExplorer> {
  const app = createExplorerApp(options);
  const host = options.host ?? '127.0.0.1';

  const server: ServerType = await new Promise((resolve) => {
    const instance = serve({ fetch: app.fetch, port: options.port ?? 7777, hostname: host }, () =>
      resolve(instance),
    );
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 7777);

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
