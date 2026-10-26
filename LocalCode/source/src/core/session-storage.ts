import fs from 'node:fs/promises';
import path from 'node:path';

/** Main-process cleanup for per-session agent transcripts under `<dataDir>/sessions/<sessionId>`.
 * Mirrors the worker's sessionStorage layout: a validated id inside the data root,
 * never following a replaced link outside it. */
export async function removeSessionStorage(dataDir: string, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new Error('会话标识无效。');
  const dataRoot = await fs.realpath(dataDir);
  const directory = path.join(dataRoot, 'sessions', sessionId);
  const parent = await fs.realpath(path.dirname(directory)).catch(() => undefined);
  const within = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!parent || !within(dataRoot, parent)) return;
  await fs.rm(directory, { recursive: true, force: true });
}
