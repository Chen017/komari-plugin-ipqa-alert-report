import type { ServerContext } from '../scheduler.ts';
import { fetchAllNodes } from '../nodes.ts';

export async function publicAccess(server: ServerContext, req: any): Promise<Set<string> | null> {
  const principal = req?.context?.principal;
  if (principal?.roles?.includes('admin') && ['user', 'api_key'].includes(principal.type)) return null;
  const settings: any = await server.call('public:getPublicSettings');
  if (!settings || settings.private_site !== false) throw new Error('Public archive access unavailable');
  return new Set((await fetchAllNodes(server)).filter(node => !node.hidden).map(node => node.uuid));
}

export function redactPublic(value: any): any {
  if (typeof value === 'string') return value
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[hidden]')
    .replace(/(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9:.]*/g, match =>
      match.includes('::') || (match.match(/:/g)?.length ?? 0) >= 3 ? '[hidden]' : match);
  if (Array.isArray(value)) return value.map(redactPublic);
  if (!value || typeof value !== 'object') return value;
  const result: any = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(ip|ipv4|ipv6|extra)$/i.test(key)) continue;
    result[key] = redactPublic(item);
  }
  if (typeof result.field === 'string' && /^info\.ip$/i.test(result.field)) {
    delete result.before; delete result.after;
    result.description = 'IP 地址发生变更';
  }
  return result;
}
