/** 与后端 /api 返回结构对应的类型定义。 */

export interface ProjectInfo {
  project_id: string;
  project_name: string;
  meter_count: number;
  address: string | null;
  updated_at: string | null;
}

export interface DiskUsage {
  totalBytes: number;
  dbBytes: number;
  usagePercent: number;
  thresholdPercent: number;
  alarm: boolean;
}

export interface Overview {
  connected: boolean;
  dbPath: string;
  dbSizeKb: number;
  dbMtime: string;
  project: ProjectInfo;
  counts: Record<string, number>;
  disk: DiskUsage;
}

export interface Trend {
  latest: number;
  prev: number | null;
  diff: number | null;
  pct: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface Kpi {
  rangeLabel: string;
  start: string | null;
  end: string | null;
  statDays: number;
  totalUsage: number;
  avgDaily: number;
  peakDaily: number;
  latestDaily: number;
  trend: Trend;
  totalCost: number;
  totalEmission: number;
  electricityPrice: number;
  emissionFactor: number;
  meterCount: number;
  onlineCount: number;
  alarmCount: number;
}

export interface DailyUsagePoint {
  date: string;
  usage_kwh: number;
}

export interface CategoryDailyPoint {
  date: string;
  category: string;
  usage_kwh: number;
}

export interface MeterDailyPoint {
  date: string;
  meter_no: string;
  category: string;
  room_detail_addr: string;
  usage_kwh: number;
}

export interface TopConsumer extends MeterDailyPoint {
  total: number;
}

export interface CategorySummary {
  category: string;
  usageKwh: number;
  ratio: number;
  cost: number;
}

export interface DailyUsageResponse {
  usageDaily: DailyUsagePoint[];
  categoryDaily: CategoryDailyPoint[];
  meterDaily: MeterDailyPoint[];
  topConsumers: TopConsumer[];
  categorySummary: CategorySummary[];
  newestDate: string | null;
  earliestDate: string | null;
}

export interface LoadCurvePoint {
  t: string;
  v: number;
}

export interface LoadCurveSeries {
  name: string;
  points: LoadCurvePoint[];
}

export interface MeterParams {
  meterNo: string;
  roomDetailAddr: string;
  category: string;
  multiplier: number;
  rate: number;
  ctRate: string;
  ptRate: string;
  commType: string;
  relayStatusDesc: string;
  onlineStatusDesc: string;
  currentKw: number;
  peakKw: number;
  avgKw: number;
  realKwh: number;
  sampleTime: string;
}

export interface LoadCurveResponse {
  mode: string;
  rangeLabel: string;
  latestTime: string;
  currentTotalKw: number;
  readyCount: number;
  periodPeakKw: number;
  periodAvgKw: number;
  series: LoadCurveSeries[];
  meterParams: MeterParams | null;
}

export interface MeterRow {
  meterNo: string;
  roomDetailAddr: string;
  category: string;
  rate: number;
  multiplier: number;
  ctRate: string;
  ptRate: string;
  realKwh: number;
  totalKwh: number;
  powerKw: number;
  relayStatusDesc: string;
  onlineStatusDesc: string;
  commType: string;
  imeiNo: string;
  sampleTime: string;
}

export interface MetersResponse {
  rows: MeterRow[];
  categories: string[];
  meterCount: number;
  total: number;
}

export interface AlarmRow {
  meterNo: string;
  alarmTime: string;
  alarmName: string;
  alarmCode: string | null;
  roomAddr: string | null;
  alarmStatus: string | null;
  createdAt: string | null;
}

export interface AlarmsResponse {
  rows: AlarmRow[];
  activeCount: number;
}
