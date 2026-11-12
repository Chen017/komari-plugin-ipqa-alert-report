import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const releaseScript = fileURLToPath(new URL('./release.mjs', import.meta.url))
const manifestFile = 'komari-plugin.json'
const hasLock = true
const hasScript = false

test('release decision, version files, and retries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'komari-release-'))
  const command = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  const run = (...args) => execFileSync(process.execPath, [releaseScript, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const put = (file, content) => writeFileSync(join(dir, file), content)
  const get = file => JSON.parse(readFileSync(join(dir, file), 'utf8'))
  try {
    command('init', '-q')
    command('config', 'user.email', 'test@example.invalid')
    command('config', 'user.name', 'Release test')
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'tests'))
    put('package.json', JSON.stringify({ version: '1.2.3', dependencies: { vue: '^3' }, scripts: { build: 'build', test: 'test' } }, null, 2) + '\n')
    put(manifestFile, JSON.stringify({ version: '1.2.3' }, null, 2) + '\n')
    if (hasLock) put('package-lock.json', JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }, null, 2) + '\n')
    if (hasScript) put('script.js', "const VERSION = '1.2.3';\n")
    put('src/main.js', 'initial\n')
    command('add', '.')
    command('commit', '-qm', 'initial')
    command('tag', 'v1.2.3')
    put('README.md', 'docs\n')
    put('tests/example.test.js', 'test\n')
    command('add', '.')
    command('commit', '-qm', 'docs and tests')
    assert.match(run('plan', 'v1.2.3'), /^publish=false/m)

    put('src/main.js', 'changed\n')
    command('add', '.')
    command('commit', '-qm', 'runtime change')
    assert.match(run('plan', 'v1.2.3'), /publish=true\nversion=1\.2\.4\nrelease_tag=v1\.2\.4/)
    run('prepare', '1.2.4')
    assert.equal(get('package.json').version, '1.2.4')
    assert.equal(get(manifestFile).version, '1.2.4')
    if (hasLock) assert.equal(get('package-lock.json').packages[''].version, '1.2.4')
    if (hasScript) assert.match(readFileSync(join(dir, 'script.js'), 'utf8'), /VERSION = '1\.2\.4'/)
    command('add', '.')
    command('commit', '-qm', 'generated version')
    assert.match(run('plan', 'v1.2.3'), /version=1\.2\.4/)
    command('tag', 'v1.2.4')
    assert.match(run('plan', 'v1.2.4'), /^publish=false/m)
    const pkg = get('package.json')
    pkg.scripts.test = 'updated tests'
    put('package.json', JSON.stringify(pkg, null, 2) + '\n')
    command('add', '.')
    command('commit', '-qm', 'test tooling only')
    assert.match(run('plan', 'v1.2.4'), /^publish=false/m)

    pkg.dependencies.vue = '^4'
    put('package.json', JSON.stringify(pkg, null, 2) + '\n')
    command('add', '.')
    command('commit', '-qm', 'runtime dependency update')
    assert.match(run('plan', 'v1.2.4'), /version=1\.2\.5/)
    assert.throws(() => run('prepare', 'invalid'))
  } finally {
    rmSync(resolve(dir), { recursive: true, force: true })
  }
})
