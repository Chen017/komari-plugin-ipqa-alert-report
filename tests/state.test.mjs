import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { INITIAL_STATE, loadState, saveState } from '../src/state.ts';
import { useTemporaryStorage } from './fixtures/storage.mjs';

test('a partial state write preserves the previous notification dedupe state', t => {
  const directory = useTemporaryStorage(t);
  const previous = {
    ...INITIAL_STATE,
    daily_delivery: {
      beijing_date: '2026-10-28',
      sent_keys: ['alert|test-node|existing'],
    },
  };
  saveState(previous);
  const originalWrite = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (filePath, content, options) => {
    originalWrite(filePath, content.slice(0, 4), options);
    throw new Error('injected partial write');
  });
  syncBuiltinESMExports();
  try {
    saveState({ ...previous, last_run_beijing_date: '2026-10-28' });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(mock.mock.callCount(), 1);
  assert.deepEqual(loadState(), previous);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('a failed state rename leaves the previous notification state intact', t => {
  const directory = useTemporaryStorage(t);
  saveState(INITIAL_STATE);
  const mock = t.mock.method(fs, 'renameSync', () => {
    throw new Error('injected rename failure');
  });
  syncBuiltinESMExports();
  try {
    saveState({ ...INITIAL_STATE, last_run_beijing_date: '2026-10-28' });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(mock.mock.callCount(), 1);
  assert.deepEqual(loadState(), INITIAL_STATE);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});
