import type { IpVersion, ManifestEntry } from './types.ts';

export const ARCHIVE_FILENAME_REGEX = /^(\d{4}-\d{2}-\d{2})_\d{6}\.json$/;

/**
 * Builds a portable POSIX shell command to list all IPQA archives on the remote VPS.
 */
export function buildManifestCommand(): string {
  return [
    'echo "__IPQA_MANIFEST_BEGIN__"',
    'for f in "$HOME/.ipqa/data/v4"/*.json; do',
    '  if [ -f "$f" ]; then',
    '    fn=$(basename "$f")',
    '    sz=$(wc -c < "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0)',
    '    mt=$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)',
    '    echo "__IPQA_ENTRY__|v4|$fn|$sz|$mt"',
    '  fi',
    'done',
    'for f in "$HOME/.ipqa/data/v6"/*.json; do',
    '  if [ -f "$f" ]; then',
    '    fn=$(basename "$f")',
    '    sz=$(wc -c < "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0)',
    '    mt=$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)',
    '    echo "__IPQA_ENTRY__|v6|$fn|$sz|$mt"',
    '  fi',
    'done',
    'echo "__IPQA_MANIFEST_END__"',
  ].join('\n');
}

/**
 * Parses the remote command stdout into structured, validated ManifestEntry items.
 */
export function parseManifestOutput(stdout: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  if (!stdout) return entries;

  const lines = stdout.split(/\r?\n/);
  let inManifest = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '__IPQA_MANIFEST_BEGIN__') {
      inManifest = true;
      continue;
    }
    if (trimmed === '__IPQA_MANIFEST_END__') {
      inManifest = false;
      break;
    }

    if (!inManifest && !trimmed.startsWith('__IPQA_ENTRY__|')) {
      continue;
    }

    if (trimmed.startsWith('__IPQA_ENTRY__|')) {
      const parts = trimmed.split('|');
      if (parts.length >= 5) {
        const ipVer = parts[1]?.trim() as IpVersion;
        const filename = parts[2]?.trim() || '';
        const size = Number.parseInt(parts[3]?.trim() || '0', 10);
        const mtime = Number.parseInt(parts[4]?.trim() || '0', 10);

        if (ipVer !== 'v4' && ipVer !== 'v6') continue;

        const match = ARCHIVE_FILENAME_REGEX.exec(filename);
        if (!match) continue; // Must strictly match YYYY-MM-DD_HHMMSS.json

        const date = match[1]!;

        entries.push({
          ipVersion: ipVer,
          filename,
          date,
          size: Number.isFinite(size) ? size : 0,
          mtime: Number.isFinite(mtime) ? mtime : 0,
        });
      }
    }
  }

  // Sort descending by filename / date (newest first)
  entries.sort((a, b) => b.filename.localeCompare(a.filename));
  return entries;
}
