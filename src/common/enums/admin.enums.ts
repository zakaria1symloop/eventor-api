export enum AuditLevel {
  Info = 'info',
  Normal = 'normal',
  Sensitive = 'sensitive',
  Security = 'security',
}

export enum AuditSource {
  Dashboard = 'dashboard',
  Android = 'android',
  Ios = 'ios',
  Web = 'web',
  System = 'system',
}

export enum ExportFormat {
  Csv = 'csv',
  Xlsx = 'xlsx',
  Pdf = 'pdf',
}

export enum ExportStatus {
  Queued = 'queued',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
}
