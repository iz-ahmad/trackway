import { startExplorer } from '@backstory/server';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspaceIndex, type Workspace } from '../workspace.js';
import type { Io } from './index.js';

/**
 * Where the prebuilt explorer lives relative to the installed CLI.
 *
 * Shipping it built is what keeps installation free of a toolchain: the user
 * gets a working explorer from `npm install`, with no build step of their own.
 */
function resolveUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'ui', 'dist');
}

export interface GraphOptions {
  port?: number;
  open?: boolean;
}

export async function graphCommand(
  workspace: Workspace,
  options: GraphOptions,
  io: Io,
): Promise<number> {
  const db = openWorkspaceIndex(workspace);

  const explorer = await startExplorer({
    db,
    uiDir: resolveUiDir(),
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  io.out(`Explorer running at ${explorer.url}`);
  io.out('No account, no network. Press Ctrl+C to stop.');

  if (options.open !== false) openInBrowser(explorer.url);

  await new Promise<void>((resolveWait) => {
    const shutdown = () => {
      void explorer.close().then(() => {
        db.close();
        resolveWait();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Printing the URL is enough; failing to launch a browser is not an error.
  }
}

export { resolveUiDir, join };
