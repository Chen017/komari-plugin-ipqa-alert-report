import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const zip = resolve(process.argv[2] ?? join(root, 'ipqa-alert-report.zip'));
const scratch = mkdtempSync(join(tmpdir(), 'ipqa-alert-report-package-'));
const require = createRequire(import.meta.url);
const windows = process.platform === 'win32';

try {
  const files = execFileSync(windows ? 'tar' : 'unzip', windows ? ['-tf', zip] : ['-Z', '-1', zip],
    { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
  assert.deepEqual(files, ['assets/icon.svg', 'komari-plugin.json', 'script.js']);
  execFileSync(windows ? 'tar' : 'unzip', windows ? ['-xf', zip, '-C', scratch] : ['-q', zip, '-d', scratch]);

  const source = JSON.parse(readFileSync(join(root, 'komari-plugin.json'), 'utf8'));
  const packaged = JSON.parse(readFileSync(join(scratch, 'komari-plugin.json'), 'utf8'));
  const beta = /^ipqa-alert-report-beta-([\da-f]+)\.zip$/.exec(basename(zip));
  const version = beta ? `${source.version}-beta.performance.g${beta[1]}` : source.version;
  assert.deepEqual(packaged, { ...source, version });
  assert.deepEqual(readFileSync(join(scratch, 'assets', 'icon.svg')), readFileSync(join(root, 'assets', 'icon.svg')));

  const routes = new Map();
  const cron = [];
  const rpc = new Map();
  const server = {
    getConfig: () => ({ enabled: false, sync_archives: false }),
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    registerRPC: (name, handler) => rpc.set(name, handler),
    cron: (schedule) => cron.push(schedule),
  };
  const runtime = {
    __storageDir__: join(scratch, 'storage'),
    require: (id) => id === 'server' ? server : require(id),
    console,
    // Leave the delayed backfill unexecuted in this offline smoke test.
    setTimeout: () => 0,
  };
  runInNewContext(readFileSync(join(scratch, 'script.js'), 'utf8'), runtime, { filename: 'script.js' });
  assert.equal(typeof runtime.load, 'function');
  assert.equal(typeof runtime.unload, 'function');
  try {
    await runtime.load();
    assert.deepEqual(cron, ['* * * * *']);
    assert.ok(routes.has('POST /api/plugin/ipqa-alert-report/test'));
    assert.ok(rpc.has('plugin:ipqaGetJob'));
    assert.ok(rpc.has('plugin:ipqaGetNodeArchive'));
    assert.equal(rpc.get('plugin:ipqaGetCapabilities')().plugin_version, packaged.version);
  } finally {
    await runtime.unload();
  }
  console.log(`Verified ${basename(zip)} (${version}) and Komari lifecycle bridge`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
