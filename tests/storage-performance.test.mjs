import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { replaceDailyReports, getLatestDailyReport, getDailyReport, listDailyDates } from '../src/storage/archive-store.ts';

test('daily rebuild publishes latest once without rereading it for every historical day', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ipqa-rebuild-'));
  const previousStorage = globalThis.__storageDir__;
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  let latestReads = 0;
  let latestWrites = 0;
  globalThis.__storageDir__ = directory;
  try {
    fs.readFileSync = function (filename, ...args) {
      if (String(filename).endsWith('latest.json')) latestReads++;
      return originalRead.call(this, filename, ...args);
    };
    fs.writeFileSync = function (filename, ...args) {
      if (String(filename).includes('latest.json.tmp.')) latestWrites++;
      return originalWrite.call(this, filename, ...args);
    };
    syncBuiltinESMExports();
    const reports = ['2026-10-03', '2026-10-02', '2026-10-01'].map(date => ({ date, nodeUuid: 'node-a', v4: { scores: { IPQS: 15 } }, v6: null }));
    replaceDailyReports('node-a', reports);
    assert.equal(latestReads, 0);
    assert.equal(latestWrites, 1);
    assert.deepEqual(getLatestDailyReport('node-a'), reports[0]);
    for (const report of reports) assert.deepEqual(getDailyReport('node-a', report.date), report);
    replaceDailyReports('node-a', reports.slice(0, 2));
    assert.deepEqual(listDailyDates('node-a'), reports.slice(0, 2).map(report => report.date));
    assert.throws(() => replaceDailyReports('node-a', [{ date: '../invalid' }]), /Invalid IPQA archive date/);
    assert.deepEqual(getLatestDailyReport('node-a'), reports[0]);
  } finally {
    fs.readFileSync = originalRead;
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    if (previousStorage === undefined) delete globalThis.__storageDir__;
    else globalThis.__storageDir__ = previousStorage;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
