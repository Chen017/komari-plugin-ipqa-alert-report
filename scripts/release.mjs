import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [action, argument] = process.argv.slice(2)
const fileForManifest = 'komari-plugin.json'
const hasLock = true
const hasScriptVersion = false

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}
function versionParts(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Expected a stable MAJOR.MINOR.PATCH version: ' + version)
  return version.split('.').map(Number)
}
function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}
function prepare(version) {
  versionParts(version)
  const pkg = readJson('package.json')
  const manifest = readJson(fileForManifest)
  pkg.version = version
  manifest.version = version
  writeJson('package.json', pkg)
  writeJson(fileForManifest, manifest)
  if (hasLock) {
    const lock = readJson('package-lock.json')
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    writeJson('package-lock.json', lock)
  }
  if (hasScriptVersion) {
    const file = 'script.js'
    const content = readFileSync(file, 'utf8')
    const marker = /^const VERSION = '[^']+';$/gm
    if ((content.match(marker) || []).length !== 1)
      throw new Error('Expected exactly one runtime version constant')
    writeFileSync(file, content.replace(marker, "const VERSION = '" + version + "';"))
  }
}
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}
function releaseRelevant(file) {
  if (file.startsWith('src/')) return !/\.(md|test\.[cm]?[jt]s)$/.test(file)
  return file.startsWith('assets/') || file.startsWith('public/')
    || ['index.html', 'komari-plugin.json', 'komari-theme.json',
      'script.js', 'logic.cjs', 'build.mjs', 'scripts/build.mjs',
      'vite.config.ts', 'docs/preview.png'].includes(file)
}
function buildConfiguration(pkg) {
  const buildTools = ['esbuild', 'vite', '@vitejs/plugin-vue', '@tailwindcss/vite',
    'tailwindcss', 'archiver']
  const selected = Object.fromEntries(buildTools.map(key => [key, pkg.devDependencies?.[key] ?? null]))
  const relevantOverrides = Object.fromEntries(Object.entries(pkg.overrides || {}).filter(([key]) =>
    ['archiver-utils', 'glob', 'minimatch', 'esbuild', 'vite'].includes(key)))
  return JSON.stringify({ dependencies: pkg.dependencies || {}, buildTools: selected,
    build: pkg.scripts?.build || '', overrides: relevantOverrides })
}
function plan(baseTag) {
  if (!/^v\d+\.\d+\.\d+$/.test(baseTag))
    throw new Error('Latest release must use a stable vMAJOR.MINOR.PATCH tag')
  execFileSync('git', ['merge-base', '--is-ancestor', baseTag, 'HEAD'])
  const previous = JSON.parse(git('show', baseTag + ':package.json'))
  const current = readJson('package.json')
  const currentVersion = current.version
  const latestVersion = baseTag.slice(1)
  versionParts(currentVersion)
  versionParts(latestVersion)
  const changed = git('diff', '--name-only', '-z', baseTag, 'HEAD').split('\0').filter(Boolean)
  const codeChanged = changed.some(releaseRelevant)
  const buildChanged = buildConfiguration(previous) !== buildConfiguration(current)
  const explicitVersion = compareVersions(currentVersion, latestVersion) > 0
  if (!codeChanged && !buildChanged && !explicitVersion) {
    console.error('No installable code or build changes since ' + baseTag)
    console.log('publish=false')
    return
  }
  let next = currentVersion
  if (!explicitVersion) {
    const [major, minor, patch] = versionParts(latestVersion)
    next = [major, minor, patch + 1].join('.')
  }
  console.error('Changes since ' + baseTag + ': ' + changed.filter(releaseRelevant).join(', '))
  console.log('publish=true')
  console.log('version=' + next)
  console.log('release_tag=v' + next)
}
if (action === 'plan') plan(argument)
else if (action === 'prepare') prepare(argument)
else throw new Error('Usage: node scripts/release.mjs plan <latest-tag> | prepare <version>')
