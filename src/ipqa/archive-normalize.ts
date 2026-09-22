import type {
  ClassifiedRiskScore,
  IpqaNormalizedReport,
  IpVersion,
  NormalizedIpVersion,
  RiskCategory,
} from './types.ts';
import { ARCHIVE_FILENAME_REGEX } from './archive-manifest.ts';
import { classifyScore, getHighestRisk, toClassifiedRiskScore } from './risk.ts';

export function toBeijingDateString(dateObj: Date): string {
  const bjMs = dateObj.getTime() + 8 * 3600 * 1000;
  const bjDate = new Date(bjMs);
  const y = bjDate.getUTCFullYear();
  const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bjDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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
  let date = match ? match[1]! : new Date().toISOString().slice(0, 10);

  let timestamp = new Date().toISOString();
  if (filename.length >= 17) {
    const timePart = filename.slice(11, 17); // HHMMSS
    const hh = timePart.slice(0, 2);
    const mm = timePart.slice(2, 4);
    const ss = timePart.slice(4, 6);
    timestamp = `${date}T${hh}:${mm}:${ss}Z`;
    // Timezone correction: if the timestamp in UTC rolls into Beijing date, correct the date
    const utcMs = Date.parse(timestamp);
    if (Number.isFinite(utcMs)) {
      date = toBeijingDateString(new Date(utcMs));
    }
  }

  const rawInfo = (raw && typeof raw.Info === 'object' && raw.Info) || (raw && typeof raw.info === 'object' && raw.info) || {};
  const rawScore = (raw && typeof raw.Score === 'object' && raw.Score) || (raw && typeof raw.scores === 'object' && raw.scores) || {};
  const rawType = (raw && typeof raw.Type === 'object' && raw.Type) || (raw && typeof raw.type === 'object' && raw.type) || {};
  const rawFactor = (raw && typeof raw.Factor === 'object' && raw.Factor) || (raw && typeof raw.factors === 'object' && raw.factors) || {};
  const rawMedia = (raw && typeof raw.Media === 'object' && raw.Media) || (raw && typeof raw.media === 'object' && raw.media) || {};
  const rawMail = (raw && typeof raw.Mail === 'object' && raw.Mail) || (raw && typeof raw.mail === 'object' && raw.mail) || {};

  // 1. Info
  const rawIp = rawInfo.IP ?? rawInfo.ip ?? raw?.Head?.IP ?? raw?.Head?.ip ?? raw?.head?.IP ?? raw?.head?.ip ?? raw?.IP ?? raw?.ip;
  
  // Extract Country
  let country = rawInfo.Country ?? rawInfo.country;
  if (country && typeof country === 'object') {
    country = country.Name || country.name || country.Code || country.code;
  }
  if (!country || country === 'null') {
    const reg = rawInfo.Region ?? rawInfo.region;
    if (reg && typeof reg === 'object') {
      country = reg.Name || reg.name || reg.Code || reg.code;
    }
  }
  if (!country || country === 'null') {
    const regReg = rawInfo.RegisteredRegion ?? rawInfo.registeredRegion;
    if (regReg && typeof regReg === 'object') {
      country = regReg.Name || regReg.name || regReg.Code || regReg.code;
    }
  }

  // Extract Region / Subdivisions
  let region = rawInfo.Region ?? rawInfo.region;
  if (typeof region === 'string') {
    region = cleanRegion(region);
  } else if (region && typeof region === 'object') {
    const cityObj = rawInfo.City ?? rawInfo.city;
    if (cityObj && typeof cityObj === 'object' && cityObj.Subdivisions && cityObj.Subdivisions !== 'null') {
      region = String(cityObj.Subdivisions).trim();
    } else if (cityObj && typeof cityObj === 'object' && cityObj.SubCode && cityObj.SubCode !== 'null') {
      region = String(cityObj.SubCode).trim();
    } else {
      region = region.Code || region.code || region.Name || region.name;
    }
  }

  // Extract City
  let city = rawInfo.City ?? rawInfo.city;
  if (city && typeof city === 'object') {
    city = city.Name || city.name || '--';
  }

  // Extract ISP
  const isp = rawInfo.ISP ?? rawInfo.isp ?? rawInfo.Organization ?? rawInfo.organization;

  const info: IpqaNormalizedReport['info'] = {
    ip: typeof rawIp === 'string' ? rawIp.trim() : rawIp,
    country: typeof country === 'string' ? country.trim() : country,
    region: typeof region === 'string' ? region.trim() : region,
    city: typeof city === 'string' ? city.trim() : city,
    asn: rawInfo.ASN ?? rawInfo.asn,
    isp: typeof isp === 'string' ? isp.trim() : isp,
    organization: rawInfo.Organization ?? rawInfo.organization,
    type: rawInfo.Type ?? rawInfo.type,
    ...rawInfo,
  };

  // 2. Scores
  const scores: Record<string, string | number | boolean | null> = {};
  const classifiedScores: Record<string, ClassifiedRiskScore> = {};
  for (const [key, val] of Object.entries(rawScore)) {
    if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      scores[key] = val;
    } else {
      scores[key] = String(val);
    }
    classifiedScores[key] = toClassifiedRiskScore(classifyScore(key, scores[key]));
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
      'Head', 'head',
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
    classifiedScores,
    type: typeObj,
    factors,
    media,
    mail,
    extra,
  };
}

/**
 * Assesses risk category from a normalized report using unified risk classification.
 */
export function getReportRiskCategory(report: IpqaNormalizedReport | null): {
  category: RiskCategory;
  source: string;
} {
  if (!report) {
    return { category: 'Unknown', source: 'None' };
  }
  const result = getHighestRisk(report.scores);
  return {
    category: result.category,
    source: result.source,
  };
}
