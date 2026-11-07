import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function useTemporaryStorage(test) {
  const directory = mkdtempSync(join(tmpdir(), 'ipqa-test-'));
  const previousDirectory = globalThis.__storageDir__;
  globalThis.__storageDir__ = directory;
  test.after(() => {
    if (previousDirectory === undefined) delete globalThis.__storageDir__;
    else globalThis.__storageDir__ = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
