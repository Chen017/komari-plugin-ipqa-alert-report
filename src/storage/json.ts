import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeJsonFile(filePath: string, data: unknown, allowCopyFallback = false): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const content = JSON.stringify(data, null, 2);
  const tempPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      if (!allowCopyFallback) throw err;
      // Archive caches retain their fallback for hosts that cannot replace a locked file.
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Preserve the original error.
    }
    throw err;
  }
}
