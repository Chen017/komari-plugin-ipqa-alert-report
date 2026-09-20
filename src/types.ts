export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface PluginConfig {
  enabled: boolean;
  all_nodes: boolean;
  nodes: string[];
  min_severity: Severity;
  ignore_initial_archive: boolean;
  notify_collection_failures: boolean;
  template: string;
}

export interface KomariNode {
  uuid: string;
  name: string;
  weight: number;
  [key: string]: unknown;
}

export interface IpqaAlert {
  timestamp: string;
  level: Severity | string;
  message: string;
  ipVersion: string;
  raw: string;
}

export type NodeCollectionStatus =
  | 'OK'
  | 'NOT_FOUND'
  | 'DATE_CONVERSION_FAILED'
  | 'EXEC_FAILED'
  | 'TIMEOUT'
  | 'PARSE_FAILED';

export interface NodeCollectionResult {
  uuid: string;
  name: string;
  weight: number;
  status: NodeCollectionStatus;
  alerts: IpqaAlert[];
  error?: string;
}

export interface DailyReport {
  beijingDate: string;
  windowStart: string;
  windowEnd: string;
  selectedNodeCount: number;
  alertNodeCount: number;
  alertCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  alertNodes: NodeCollectionResult[];
  failedNodes: NodeCollectionResult[];
}

export interface PluginState {
  schema_version: number;
  last_run_beijing_date: string;
  last_success_at?: string;
  last_task_id?: string;
  last_summary?: {
    selected_nodes: number;
    alert_nodes: number;
    alerts: number;
    collection_failures: number;
  };
  attempt_date?: string;
  attempt_count?: number;
}

export interface TaskExecResult {
  task_id?: string;

  client_id?: string;
  client?: string;
  uuid?: string;

  /**
   * Native Komari command output.
   */
  result?: string;

  /**
   * Normalized aliases used internally by this plugin.
   */
  stdout?: string;
  stderr?: string;

  /**
   * Komari:
   * null   => task is still pending
   * number => task has finished
   */
  exit_code?: number | null;

  /**
   * Komari:
   * null      => task is still pending
   * timestamp => task has finished
   */
  finished_at?: string | null;

  created_at?: string;

  client_info?: unknown;

  /**
   * Compatibility / synthetic fields.
   */
  status?: string;
  success?: boolean;
  error?: string;

  [key: string]: unknown;
}

