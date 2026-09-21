import type { IpVersion } from './types.ts';
import { ARCHIVE_FILENAME_REGEX } from './archive-manifest.ts';

export interface BatchFetchTarget {
  ipVersion: IpVersion;
  filename: string;
}

export interface FetchedArchive {
  ipVersion: IpVersion;
  filename: string;
  rawJson: any;
}

/**
 * Builds a bounded batch fetch command in POSIX shell.
 * Uses unambiguous base64 framing per file.
 */
export function buildBatchFetchCommand(targets: BatchFetchTarget[]): string {
  const lines: string[] = ['echo "__IPQA_BATCH_BEGIN__"'];

  for (const target of targets) {
    if (!ARCHIVE_FILENAME_REGEX.test(target.filename)) continue;
    const ipVer = target.ipVersion === 'v6' ? 'v6' : 'v4';
    const filePath = `"$HOME/.ipqa/data/${ipVer}/${target.filename}"`;

    lines.push(`if [ -f ${filePath} ]; then`);
    lines.push(`  echo "__IPQA_FILE_BEGIN__|${ipVer}|${target.filename}"`);
    lines.push(`  base64 ${filePath} 2>/dev/null || openssl base64 -in ${filePath} 2>/dev/null`);
    lines.push(`  echo "__IPQA_FILE_END__"`);
    lines.push('fi');
  }

  lines.push('echo "__IPQA_BATCH_END__"');
  return lines.join('\n');
}

/**
 * Parses the batch fetch stdout, decodes base64, and validates JSON.
 */
export function parseBatchFetchOutput(stdout: string): FetchedArchive[] {
  const results: FetchedArchive[] = [];
  if (!stdout) return results;

  const lines = stdout.split(/\r?\n/);
  let currentTarget: { ipVersion: IpVersion; filename: string } | null = null;
  let base64Chunks: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('__IPQA_FILE_BEGIN__|')) {
      const parts = trimmed.split('|');
      const ipVer = parts[1]?.trim() as IpVersion;
      const filename = parts[2]?.trim() || '';

      if ((ipVer === 'v4' || ipVer === 'v6') && ARCHIVE_FILENAME_REGEX.test(filename)) {
        currentTarget = { ipVersion: ipVer, filename };
        base64Chunks = [];
      } else {
        currentTarget = null;
      }
      continue;
    }

    if (trimmed === '__IPQA_FILE_END__') {
      if (currentTarget && base64Chunks.length > 0) {
        try {
          const base64Str = base64Chunks.join('');
          const decodedStr = Buffer.from(base64Str, 'base64').toString('utf-8');
          const parsed = JSON.parse(decodedStr);
          if (parsed && typeof parsed === 'object') {
            results.push({
              ipVersion: currentTarget.ipVersion,
              filename: currentTarget.filename,
              rawJson: parsed,
            });
          }
        } catch (err) {
          console.warn(
            `[IPQA] Failed to decode/parse fetched archive ${currentTarget.filename}:`,
            err
          );
        }
      }
      currentTarget = null;
      base64Chunks = [];
      continue;
    }

    if (currentTarget) {
      base64Chunks.push(trimmed);
    }
  }

  return results;
}
