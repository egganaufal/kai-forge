// Kai Forge entry point: bind an ephemeral port, register it with the
// environment, then wait until the environment says the trial is over.
// The forge never exits on its own before that signal — an early exit
// scores zero — and it never writes anything to disk.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tell the environment which port this forge listens on; retry until it sticks. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

/** Long-poll the environment until the trial is finished. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not done yet; poll again.
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: an ephemeral port on every interface, so the environment can
    // reach the forge at the address its register request came from.
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
