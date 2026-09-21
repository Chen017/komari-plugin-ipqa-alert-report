export type IpVersion = 'v4' | 'v6';
export type NormalizedIpVersion = 'IPv4' | 'IPv6';

export interface ManifestEntry {
  ipVersion: IpVersion;
  filename: string; // e.g. 2026-09-21_040002.json
  date: string; // YYYY-MM-DD
  size: number;
  mtime: number;
}

export interface IpqaNormalizedReport {
  schemaVersion: 1;
  ipVersion: NormalizedIpVersion;
  archiveId: string;
  date: string; // YYYY-MM-DD
  timestamp: string; // ISO string
  info: {
    ip?: string;
    country?: string;
    region?: string;
    city?: string;
    asn?: string | number;
    isp?: string;
    organization?: string;
    type?: string;
    [key: string]: unknown;
  };
  scores: Record<string, string | number | boolean | null>;
  type: {
    usage: Record<string, unknown>;
    company: Record<string, unknown>;
    raw?: unknown;
  };
  factors: Record<string, Record<string, boolean | string | number | null>>;
  media: Record<
    string,
    {
      status?: string;
      region?: string;
      [key: string]: unknown;
    }
  >;
  mail: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export type RiskCategory = 'Low' | 'Medium' | 'High' | 'Critical' | 'Unknown';

export interface IpqaDailySummary {
  hasV4: boolean;
  hasV6: boolean;
  highestRiskCategory: RiskCategory;
  highestRiskSource: string;
  mediaSummary: Record<string, { unlocked: boolean; region?: string }>;
  aiSummary: Record<string, { unlocked: boolean; region?: string }>;
}

export interface IpqaDailyPairedReport {
  schemaVersion: 1;
  nodeUuid: string;
  date: string; // YYYY-MM-DD
  updatedAt: string;
  v4: IpqaNormalizedReport | null;
  v6: IpqaNormalizedReport | null;
  summary: IpqaDailySummary;
  changesFromPrevious?: IpqaSemanticChange[];
}

export type ChangeCategory =
  | 'identity'
  | 'score'
  | 'type'
  | 'factor'
  | 'media'
  | 'mail'
  | 'dnsbl'
  | 'other';

export type ChangeSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface IpqaSemanticChange {
  date: string;
  nodeUuid: string;
  ipVersion: NormalizedIpVersion;
  category: ChangeCategory;
  severity: ChangeSeverity;
  field: string;
  before: unknown;
  after: unknown;
  description: string;
}

export type NodeIpqaStatus = 'ok' | 'not_installed' | 'no_archive' | 'stale' | 'collection_error';

export interface IpqaNodeProtocolSummary {
  date?: string | null;
  risk?: {
    category: RiskCategory;
    source: string;
  };
  scores: Record<string, string | number | boolean | null>;
  media: Record<string, { status?: string; region?: string; unlocked?: boolean; [key: string]: unknown }>;
  ai: Record<string, { status?: string; region?: string; unlocked?: boolean; [key: string]: unknown }>;
}

export interface IpqaNodeOverview {
  uuid: string;
  name: string;
  status: NodeIpqaStatus;
  latest_date: string | null;
  has_ipv4: boolean;
  has_ipv6: boolean;
  highest_risk: {
    category: RiskCategory;
    source: string;
  };
  media_summary: Record<string, { unlocked: boolean; region?: string }>;
  ai_summary: Record<string, { unlocked: boolean; region?: string }>;
  changes_today: number;
  v4?: IpqaNodeProtocolSummary;
  v6?: IpqaNodeProtocolSummary;
}

export interface IpqaFleetOverview {
  schema_version: 1;
  updated_at: string;
  total_nodes: number;
  ipqa_nodes: number;
  nodes_with_risk: number;
  nodes_with_changes_today: number;
  latest_archive_date: string | null;
  nodes: IpqaNodeOverview[];
}
