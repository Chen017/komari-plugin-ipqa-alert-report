import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginState } from './types.ts';

// Komari injects __storageDir__ as a global variable for the plugin's persistent storage
declare const __storageDir__: string | undefined;

export function getStorageDir(): string {
  if (typeof __storageDir__ !== 'undefined' && __storageDir__) {
    return __storageDir__;
  }
  return path.resolve(process.cwd(), 'storage');
}

export function getStateFilePath(): string {
  return path.join(getStorageDir(), 'state.json');
}

export const INITIAL_STATE: PluginState = {
  schema_version: 1,
  last_run_beijing_date: '',
  attempt_count: 0,
};

/**
 * Loads persistent state from state.json safely.
 */
export function loadState(): PluginState {
  const filePath = getStateFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return {
          ...INITIAL_STATE,
          ...parsed,
        };
      }
    }
  } catch (err) {
    console.error('[IPQA] Failed to load state.json, using initial state', err);
  }
  return { ...INITIAL_STATE };
}

/**
 * Saves state atomically by writing to a temp file and renaming it.
 */
export function saveState(state: PluginState): void {
  const dir = getStorageDir();
  const filePath = getStateFilePath();
  const tempPath = path.join(dir, `state.json.tmp.${Date.now()}`);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error('[IPQA] Failed to save state.json', err);
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore
    }
  }
}
