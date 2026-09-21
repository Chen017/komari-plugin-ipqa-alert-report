import type {
  IpqaNormalizedReport,
  IpVersion,
  NormalizedIpVersion,
  RiskCategory,
} from './types.ts';
import { ARCHIVE_FILENAME_REGEX } from './archive-manifest.ts';

export function cleanRegion(raw: unknown): string {
  if (typeof raw !== 'string') return '--';
  const str = raw.trim();
  if (!str || str === 'null' || str === '--') return '--';

  // Strip ANSI color codes
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[([A-Za-z]{2})\]/, '$1');
  const match = stripped.match(/([A-Za-z]{2})/);
  if (match) {
    return match[1]!.toUpperCase();
  }
  return stripped.trim() || '--';
}

/**
 * Normalizes raw IPQA JSON into Schema Version 1.
 * Preserves all unknown fields in `extra` to support future IPQA updates.
 */
export function normalizeRawIpqa(
  raw: any,
  ipVer: IpVersion,
  filename: string
): IpqaNormalizedReport {
  const normIpVer: NormalizedIpVersion = ipVer === 'v6' ? 'IPv6' : 'IPv4';

  // Parse date and time from filename: YYYY-MM-DD_HHMMSS.json
  const match = ARCHIVE_FILENAME_REGEX.exec(filename);
  const date = match ? match[1]! : new Date().toISOString().slice(0, 10);

  let timestamp = new Date().toISOString();
  if (filename.length >= 17) {
    const timePart = filename.slice(11, 17); // HHMMSS
    const hh = timePart.slice(0, 2);
    const mm = timePart.slice(2, 4);
    const ss = timePart.slice(4, 6);
    timestamp = `${date}T${hh}:${mm}:${ss}Z`;
  }

  const rawInfo = (raw && typeof raw.Info === 'object' && raw.Info) || (raw && typeof raw.info === 'object' && raw.info) || {};
  const rawScore = (raw && typeof raw.Score === 'object' && raw.Score) || (raw && typeof raw.scores === 'object' && raw.scores) || {};
  const rawType = (raw && typeof raw.Type === 'object' && raw.Type) || (raw && typeof raw.type === 'object' && raw.type) || {};
  const rawFactor = (raw && typeof raw.Factor === 'object' && raw.Factor) || (raw && typeof raw.factors === 'object' && raw.factors) || {};
  const rawMedia = (raw && typeof raw.Media === 'object' && raw.Media) || (raw && typeof raw.media === 'object' && raw.media) || {};
  const rawMail = (raw && typeof raw.Mail === 'object' && raw.Mail) || (raw && typeof raw.mail === 'object' && raw.mail) || {};

  // 1. Info
  const info: IpqaNormalizedReport['info'] = {
    ip: rawInfo.IP ?? rawInfo.ip,
    country: rawInfo.Country ?? rawInfo.country,
    region: rawInfo.Region ?? rawInfo.region,
    city: rawInfo.City ?? rawInfo.city,
    asn: rawInfo.ASN ?? rawInfo.asn,
    isp: rawInfo.ISP ?? rawInfo.isp,
    organization: rawInfo.Organization ?? rawInfo.organization,
    type: rawInfo.Type ?? rawInfo.type,
    ...rawInfo,
  };

  // 2. Scores
  const scores: Record<string, string | number | boolean | null> = {};
  for (const [key, val] of Object.entries(rawScore)) {
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      scores[key] = val;
    } else {
      scores[key] = String(val);
    }
  }

  // 3. Type
  const typeObj: IpqaNormalizedReport['type'] = {
    usage: (rawType.Usage && typeof rawType.Usage === 'object' ? rawType.Usage : (rawType.usage || {})) as Record<string, unknown>,
    company: (rawType.Company && typeof rawType.Company === 'object' ? rawType.Company : (rawType.company || {})) as Record<string, unknown>,
    raw: rawType,
  };

  // 4. Factors
  const factors: Record<string, Record<string, boolean | string | number | null>> = {};
  for (const [factorName, factorObj] of Object.entries(rawFactor)) {
    if (factorObj && typeof factorObj === 'object') {
      factors[factorName] = {};
      for (const [engine, val] of Object.entries(factorObj as Record<string, unknown>)) {
        if (typeof val === 'boolean' || typeof val === 'string' || typeof val === 'number' || val === null) {
          factors[factorName]![engine] = val;
        } else {
          factors[factorName]![engine] = Boolean(val);
        }
      }
    }
  }

  // 5. Media
  const media: Record<string, { status?: string; region?: string; [key: string]: unknown }> = {};
  for (const [service, serviceData] of Object.entries(rawMedia)) {
    if (serviceData && typeof serviceData === 'object') {
      const sObj = serviceData as Record<string, unknown>;
      const status = typeof sObj.Status === 'string' ? sObj.Status : (typeof sObj.status === 'string' ? sObj.status : undefined);
      const region = cleanRegion(sObj.Region ?? sObj.region);
      media[service] = {
        status,
        region: region === '--' ? undefined : region,
        ...sObj,
      };
    }
  }

  // 6. Mail
  const mail = (rawMail && typeof rawMail === 'object' ? rawMail : {}) as Record<string, unknown>;

  // 7. Extra: preserve any other top-level keys
  const extra: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    const knownKeys = new Set([
      'Info', 'info',
      'Score', 'score', 'scores',
      'Type', 'type',
      'Factor', 'factor', 'factors',
      'Media', 'media',
      'Mail', 'mail',
    ]);
    for (const [k, v] of Object.entries(raw)) {
      if (!knownKeys.has(k)) {
        if (k === 'extra' && v && typeof v === 'object') {
          Object.assign(extra, v);
        } else {
          extra[k] = v;
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    ipVersion: normIpVer,
    archiveId: filename,
    date,
    timestamp,
    info,
    scores,
    type: typeObj,
    factors,
    media,
    mail,
    extra,
  };
}

/**
 * Assesses risk category from a normalized report.
 */
export function getReportRiskCategory(report: IpqaNormalizedReport | null): {
  category: RiskCategory;
  source: string;
} {
  if (!report) {
    return { category: 'Unknown', source: 'None' };
  }

  const scores = report.scores;
  let highestCategory: RiskCategory = 'Low';
  let highestSource = 'None';

  // 1. IPQS (0-100, >= 85 Critical, >= 75 High, >= 50 Medium)
  if (scores.IPQS !== undefined && scores.IPQS !== null) {
    const num = Number(scores.IPQS);
    if (Number.isFinite(num)) {
      if (num >= 85) return { category: 'Critical', source: 'IPQS' };
      if (num >= 75) { highestCategory = 'High'; highestSource = 'IPQS'; }
      else if (num >= 50 && highestCategory === 'Low') { highestCategory = 'Medium'; highestSource = 'IPQS'; }
    }
  }

  // 2. SCAMALYTICS (0-100, >= 70 High, >= 25 Medium)
  if (scores.SCAMALYTICS !== undefined && scores.SCAMALYTICS !== null) {
    const num = Number(scores.SCAMALYTICS);
    if (Number.isFinite(num)) {
      if (num >= 75) { highestCategory = 'High'; highestSource = 'SCAMALYTICS'; }
      else if (num >= 25 && highestCategory === 'Low') { highestCategory = 'Medium'; highestSource = 'SCAMALYTICS'; }
    }
  }

  // 3. AbuseIPDB
  if (scores.AbuseIPDB !== undefined && scores.AbuseIPDB !== null) {
    const num = Number(scores.AbuseIPDB);
    if (Number.isFinite(num)) {
      if (num >= 50) { highestCategory = 'High'; highestSource = 'AbuseIPDB'; }
      else if (num >= 20 && highestCategory === 'Low') { highestCategory = 'Medium'; highestSource = 'AbuseIPDB'; }
    }
  }

  // 4. IP2LOCATION
  if (scores.IP2LOCATION) {
    const str = String(scores.IP2LOCATION).toUpperCase();
    if (str.includes('VERY HIGH')) return { category: 'Critical', source: 'IP2LOCATION' };
    if (str.includes('HIGH')) { highestCategory = 'High'; highestSource = 'IP2LOCATION'; }
    else if (str.includes('MEDIUM') && highestCategory === 'Low') { highestCategory = 'Medium'; highestSource = 'IP2LOCATION'; }
  }

  return { category: highestCategory, source: highestSource };
}
