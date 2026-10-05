export type MediaUnlockState = 'unlocked' | 'dns' | 'limited' | 'blocked' | 'unknown';

const blocked = /未解锁|不解锁|失败|屏蔽|不支持|无法|中国|禁会员|^(?:no|noprem|china|blocked?|failed|unsupported)\b|not\s+(?:unlocked|supported|available)/i;
const limited = /仅自制|仅网页|仅APP|originals|nf\.only|webonly|apponly|机房|\bidc\b|待支持|pending/i;
const positive = /解锁|\b(?:yes|native|unlocked)\b/i;
const dns = /dns|代理解锁|\bproxy\b/i;

export function classifyMediaUnlock(service?: { status?: string; [key: string]: unknown }) {
  const status = typeof service?.status === 'string' ? service.status.trim() : '';
  const type = service?.Type ?? service?.type ?? '';
  let state: MediaUnlockState = 'unknown';
  if (blocked.test(status)) state = 'blocked';
  else if (limited.test(status)) state = 'limited';
  else if (positive.test(status)) state = dns.test(`${type} ${status}`) ? 'dns' : 'unlocked';
  return { ...service, state, unlocked: state === 'unlocked' || state === 'dns' || state === 'limited' };
}
