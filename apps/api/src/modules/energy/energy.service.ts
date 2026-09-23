import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_ELECTRICITY_PRICE,
  DEFAULT_METER_COUNT,
  EMISSION_FACTOR_TON_PER_KWH,
  type LoadCurveMode,
} from '@energy/shared';
import { DatabaseService, type DbFingerprint, type DiskUsage } from '../database/database.service';
import {
  computeDailyUsage,
  computePowerSamples,
  parseLocalDateTime,
  type CategoryDailyPoint,
  type DailyUsagePoint,
  type LoadSampleRow,
  type MeterDailyPoint,
  type MeterReadingRow,
  type PowerSampleRow,
} from './compute';

// ---------------------------------------------------------------------------
// 行类型（对应 SQLite 表结构）
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  project_id: string;
  project_name: string;
  meter_count: number;
  address: string | null;
  updated_at: string | null;
}

export interface MeterRow {
  meter_no: string;
  project_id: string;
  room_detail_addr: string | null;
  category: string | null;
  rate: number;
  ct_rate: string | null;
  pt_rate: string | null;
  gateway_no: string | null;
  meter_type: string | null;
  comm_type: string | null;
  imei_no: string | null;
  sim_no: string | null;
  updated_at: string | null;
}

export interface AlarmRow {
  meter_no: string;
  project_id: string;
  alarm_time: string;
  alarm_name: string;
  alarm_code: string | null;
  room_addr: string | null;
  alarm_status: string | null;
  created_at: string | null;
}

/** 看板基础数据（不含 15 分钟采样，采样按需下钻加载以控制内存）。 */
export interface DashboardData {
  connected: boolean;
  error?: string;
  dbPath: string;
  dbSizeKb: number;
  dbMtime: string;
  project: ProjectInfo;
  meters: MeterRow[];
  usageDaily: DailyUsagePoint[];
  categoryDaily: CategoryDailyPoint[];
  meterDaily: MeterDailyPoint[];
  alarms: AlarmRow[];
  counts: Record<string, number>;
}

export interface DateRange {
  start: string | null;
  end: string | null;
  label: string;
}

interface CacheEntry {
  fingerprint: DbFingerprint;
  changeVersion: number;
  data: DashboardData;
}

/** 采样行公共查询片段（JOIN meters 得到分类与点位）。 */
const SAMPLE_SELECT = `
  SELECT s.meter_no, s.sample_time, s.total_kwh, s.multiplier, s.real_kwh,
         s.relay_status, s.online_status,
         COALESCE(m.category, '其他负荷') AS category,
         COALESCE(m.room_detail_addr, s.meter_no) AS room_detail_addr,
         m.rate, m.ct_rate, m.pt_rate, m.comm_type, m.imei_no
  FROM meter_load_samples s
  LEFT JOIN meters m ON s.meter_no = m.meter_no
  WHERE s.real_kwh > 0
`;

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

@Injectable()
export class EnergyService {
  private readonly logger = new Logger(EnergyService.name);
  private cache: CacheEntry | null = null;

  constructor(private readonly db: DatabaseService) {}

  /** 载入基础数据（不含采样）并聚合计算；按数据库指纹 + 写版本缓存。 */
  getDashboardData(): DashboardData {
    const fingerprint = this.db.fingerprint();
    const changeVersion = this.db.changeVersion;
    if (
      this.cache &&
      this.sameFingerprint(this.cache.fingerprint, fingerprint) &&
      this.cache.changeVersion === changeVersion
    ) {
      return this.cache.data;
    }

    const data = this.loadAll(fingerprint);
    this.cache = { fingerprint, changeVersion, data };
    return data;
  }

  private sameFingerprint(a: DbFingerprint, b: DbFingerprint): boolean {
    return a.mtimeMs === b.mtimeMs && a.size === b.size && a.dataVersion === b.dataVersion;
  }

  private loadAll(fingerprint: DbFingerprint): DashboardData {
    const { dbPath } = this.db;
    const { mtimeMs, size } = fingerprint;

    const project =
      this.db.queryOne<ProjectInfo>('SELECT * FROM projects LIMIT 1') ??
      ({
        project_id: '202607020000000001',
        project_name: '宁波慈溪凤起潮鸣',
        meter_count: DEFAULT_METER_COUNT,
        address: null,
        updated_at: null,
      } as ProjectInfo);

    const meters = this.db.queryAll<MeterRow>('SELECT * FROM meters ORDER BY room_detail_addr');

    const readings = this.db.queryAll<MeterReadingRow>(`
      SELECT r.meter_no, r.data_time, r.total_kwh, r.multiplier, r.real_kwh,
             r.rate1_kwh, r.rate2_kwh, r.rate3_kwh, r.rate4_kwh,
             COALESCE(m.category, '其他负荷') AS category,
             COALESCE(m.room_detail_addr, r.meter_no) AS room_detail_addr
      FROM meter_readings r
      LEFT JOIN meters m ON r.meter_no = m.meter_no
      WHERE r.data_time LIKE '%00:00:00'
      ORDER BY r.meter_no, r.data_time
    `);

    const alarms = this.db.queryAll<AlarmRow>(`
      SELECT meter_no, project_id, alarm_time, alarm_name, alarm_code, room_addr, alarm_status, created_at
      FROM alarm_events ORDER BY alarm_time DESC
    `);

    const counts: Record<string, number> = {};
    for (const table of ['projects', 'meters', 'meter_readings', 'meter_load_samples', 'alarm_events']) {
      counts[table] = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
    }

    const { usageDaily, categoryDaily, meterDaily } = computeDailyUsage(readings);

    return {
      connected: true,
      dbPath,
      dbSizeKb: Math.round((size / 1024) * 10) / 10,
      dbMtime: new Date(mtimeMs).toLocaleString('sv-SE', { hour12: false }).replace('T', ' '),
      project,
      meters,
      usageDaily,
      categoryDaily,
      meterDaily,
      alarms,
      counts,
    };
  }

  // -------------------------------------------------------------------------
  // 采样下钻（按需加载，避免全量驻留内存）
  // -------------------------------------------------------------------------

  /** 每表最近两条采样，用于推算最新功率；返回每表最新一条（含 power_kw）。 */
  private getLatestSamples(): PowerSampleRow[] {
    const rows = this.db.queryAll<LoadSampleRow>(`
      SELECT * FROM (
        SELECT s.meter_no, s.sample_time, s.total_kwh, s.multiplier, s.real_kwh,
               s.relay_status, s.online_status,
               COALESCE(m.category, '其他负荷') AS category,
               COALESCE(m.room_detail_addr, s.meter_no) AS room_detail_addr,
               m.rate, m.ct_rate, m.pt_rate, m.comm_type, m.imei_no,
               ROW_NUMBER() OVER (PARTITION BY s.meter_no ORDER BY s.sample_time DESC) AS rn
        FROM meter_load_samples s
        LEFT JOIN meters m ON s.meter_no = m.meter_no
        WHERE s.real_kwh > 0
      ) WHERE rn <= 2
      ORDER BY meter_no, sample_time
    `);
    const computed = computePowerSamples(rows);
    const latestByMeter = new Map<string, PowerSampleRow>();
    for (const s of computed) latestByMeter.set(s.meter_no, s);
    return [...latestByMeter.values()];
  }

  /** 按日期范围加载采样（前后各多取一天保证区间边界功率正确），计算功率后裁剪到区间。 */
  private getRangeSamples(range: DateRange): PowerSampleRow[] {
    const params: Record<string, string> = {};
    let sql = SAMPLE_SELECT;

    if (range.start) {
      params.lower = `${this.addDays(range.start, -1)} 00:00:00`;
      sql += ` AND s.sample_time >= :lower`;
    }
    if (range.end) {
      params.upper = `${this.addDays(range.end, 1)} 23:59:59`;
      sql += ` AND s.sample_time <= :upper`;
    }
    sql += ` ORDER BY s.meter_no, s.sample_time`;

    const rows = this.db.queryAll<LoadSampleRow>(sql, params);
    const computed = computePowerSamples(rows);

    const startTs = range.start ? parseLocalDateTime(`${range.start} 00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const endTs = range.end ? parseLocalDateTime(`${range.end} 23:59:59`).getTime() : Number.POSITIVE_INFINITY;
    return computed.filter((s) => s.datetime.getTime() >= startTs && s.datetime.getTime() <= endTs);
  }

  private addDays(dateStr: string, delta: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  // -------------------------------------------------------------------------
  // 日期范围筛选（日级数据，量小，仍在内存过滤）
  // -------------------------------------------------------------------------

  resolveRange(start?: string, end?: string): DateRange {
    const s = start?.trim() || null;
    const e = end?.trim() || null;
    const label = s || e ? `${s ?? '最早'} ~ ${e ?? '今天'}` : '全部历史';
    return { start: s, end: e, label };
  }

  /** 按日期范围过滤日级数据（闭区间，日期字符串可直接比较）。 */
  filterDailyByRange<T extends { date: string }>(rows: T[], range: DateRange): T[] {
    return rows.filter((r) => (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end));
  }

  // -------------------------------------------------------------------------
  // 概览 / KPI
  // -------------------------------------------------------------------------

  getOverview() {
    const data = this.getDashboardData();
    const disk = this.db.getDiskUsage();
    if (disk.alarm) {
      this.recordDiskAlarm(disk, data.project.project_id);
    }
    return {
      connected: data.connected,
      dbPath: data.dbPath,
      dbSizeKb: data.dbSizeKb,
      dbMtime: data.dbMtime,
      project: data.project,
      counts: data.counts,
      disk,
    };
  }

  /** 记录磁盘空间超限告警（每天最多一条，避免重复写入）。 */
  private recordDiskAlarm(disk: DiskUsage, projectId: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.db.queryOne<{ id: number }>(
      `SELECT id FROM alarm_events WHERE meter_no = :meter_no AND alarm_name = :alarm_name AND alarm_time = :alarm_time`,
      { meter_no: 'SYSTEM', alarm_name: '磁盘空间超限', alarm_time: today },
    );
    if (existing) return;

    const now = new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
    this.db.run(
      `INSERT INTO alarm_events (meter_no, project_id, alarm_time, alarm_name, alarm_code, room_addr, alarm_status, raw_data, created_at)
       VALUES (:meter_no, :project_id, :alarm_time, :alarm_name, :alarm_code, :room_addr, :alarm_status, :raw_data, :created_at)`,
      {
        meter_no: 'SYSTEM',
        project_id: projectId,
        alarm_time: today,
        alarm_name: '磁盘空间超限',
        alarm_code: 'DISK_USAGE_HIGH',
        room_addr: '系统',
        alarm_status: '告警中',
        raw_data: JSON.stringify(disk),
        created_at: now,
      },
    );
  }

  getKpi(start?: string, end?: string) {
    const data = this.getDashboardData();
    const range = this.resolveRange(start, end);
    const uView = this.filterDailyByRange(data.usageDaily, range);

    const totalUsage = uView.reduce((s, r) => s + r.usage_kwh, 0);
    const avgDaily = uView.length ? totalUsage / uView.length : 0;
    const peakDaily = uView.reduce((m, r) => Math.max(m, r.usage_kwh), 0);

    let trend: {
      latest: number;
      prev: number | null;
      diff: number | null;
      pct: number | null;
      direction: 'up' | 'down' | 'flat';
    } = { latest: 0, prev: null, diff: null, pct: null, direction: 'flat' };

    if (uView.length >= 1) {
      const latest = uView[uView.length - 1].usage_kwh;
      const prev = uView.length >= 2 ? uView[uView.length - 2].usage_kwh : null;
      const diff = prev === null ? null : latest - prev;
      const pct = prev ? (diff! / prev) * 100 : null;
      trend = {
        latest,
        prev,
        diff,
        pct,
        direction: diff === null || diff === 0 ? 'flat' : diff > 0 ? 'up' : 'down',
      };
    }

    const onlineCount = this.getLatestSamples().filter((s) => s.online_status_desc === '在线').length;
    const alarmCount = data.alarms.filter((a) => a.alarm_status === '告警中').length;
    const meterCount = data.project.meter_count || DEFAULT_METER_COUNT;

    return {
      rangeLabel: range.label,
      start: range.start,
      end: range.end,
      statDays: uView.length,
      totalUsage,
      avgDaily,
      peakDaily,
      latestDaily: trend.latest,
      trend,
      totalCost: totalUsage * DEFAULT_ELECTRICITY_PRICE,
      totalEmission: totalUsage * EMISSION_FACTOR_TON_PER_KWH,
      electricityPrice: DEFAULT_ELECTRICITY_PRICE,
      emissionFactor: EMISSION_FACTOR_TON_PER_KWH,
      meterCount,
      onlineCount,
      alarmCount,
    };
  }

  // -------------------------------------------------------------------------
  // 日用电明细（TAB 1）
  // -------------------------------------------------------------------------

  getDailyUsage(start?: string, end?: string) {
    const data = this.getDashboardData();
    const range = this.resolveRange(start, end);
    const usageDaily = this.filterDailyByRange(data.usageDaily, range);
    const categoryDaily = this.filterDailyByRange(data.categoryDaily, range);
    const meterDaily = this.filterDailyByRange(data.meterDaily, range);

    // 耗电 Top5（按累计用电）
    const meterSum = new Map<string, MeterDailyPoint & { total: number }>();
    for (const m of meterDaily) {
      const cur = meterSum.get(m.meter_no);
      if (cur) cur.total += m.usage_kwh;
      else meterSum.set(m.meter_no, { ...m, total: m.usage_kwh });
    }
    const topConsumers = [...meterSum.values()].sort((a, b) => b.total - a.total).slice(0, 5);

    // 分类汇总（占比 + 电费）
    const catSum = new Map<string, number>();
    for (const c of categoryDaily) catSum.set(c.category, (catSum.get(c.category) ?? 0) + c.usage_kwh);
    const total = [...catSum.values()].reduce((s, v) => s + v, 0);
    const categorySummary = [...catSum.entries()]
      .map(([category, usage]) => ({
        category,
        usageKwh: usage,
        ratio: total > 0 ? (usage / total) * 100 : 0,
        cost: usage * DEFAULT_ELECTRICITY_PRICE,
      }))
      .sort((a, b) => b.usageKwh - a.usageKwh);

    const newestDate = usageDaily.length ? usageDaily[usageDaily.length - 1].date : null;
    const earliestDate = usageDaily.length ? usageDaily[0].date : null;

    return { usageDaily, categoryDaily, meterDaily, topConsumers, categorySummary, newestDate, earliestDate };
  }

  // -------------------------------------------------------------------------
  // 实时负荷曲线（TAB 2）
  // -------------------------------------------------------------------------

  getLoadCurve(start: string | undefined, end: string | undefined, mode: LoadCurveMode, meterNos: string[], category?: string) {
    const data = this.getDashboardData();
    const range = this.resolveRange(start, end);
    const sView = this.getRangeSamples(range);

    // 关键指标（current 使用全量最新采样，区间峰值使用 sView）
    const latestSamples = this.getLatestSamples();
    const latestTime = latestSamples.length
      ? latestSamples.reduce((m, s) => (s.sample_time > m ? s.sample_time : m), '')
      : '';
    const latestSlice = latestSamples.filter((s) => s.sample_time === latestTime);
    const currentTotalKw = latestSlice.reduce((s, r) => s + r.power_kw, 0);

    const timeGrouped = new Map<string, number>();
    for (const s of sView) timeGrouped.set(s.sample_time, (timeGrouped.get(s.sample_time) ?? 0) + s.power_kw);
    const periodValues = [...timeGrouped.values()];
    const periodPeakKw = periodValues.length ? Math.max(...periodValues) : 0;
    const periodAvgKw = periodValues.length ? periodValues.reduce((a, b) => a + b, 0) / periodValues.length : 0;

    const series: Array<{ name: string; points: Array<{ t: string; v: number }> }> = [];
    let meterParams: Record<string, unknown> | null = null;

    if (mode === 'total') {
      const grouped = this.groupSumByTime(sView);
      series.push({ name: '园区总负荷', points: grouped });
    } else if (mode === 'single' && meterNos.length === 1) {
      const mNo = meterNos[0];
      const sub = sView.filter((s) => s.meter_no === mNo);
      const label = sub[0]?.room_detail_addr || mNo;
      series.push({ name: label, points: sub.map((s) => ({ t: s.sample_time, v: s.power_kw })) });
      meterParams = this.buildMeterParams(sub, mNo);
    } else if (mode === 'multi' && meterNos.length > 0) {
      for (const mNo of meterNos) {
        const sub = sView.filter((s) => s.meter_no === mNo);
        series.push({ name: sub[0]?.room_detail_addr || mNo, points: sub.map((s) => ({ t: s.sample_time, v: s.power_kw })) });
      }
    } else if (mode === 'category' && category) {
      const sub = sView.filter((s) => s.category === category);
      series.push({ name: category, points: this.groupSumByTime(sub) });
    }

    return {
      mode,
      rangeLabel: range.label,
      latestTime,
      currentTotalKw,
      readyCount: latestSlice.length,
      periodPeakKw,
      periodAvgKw,
      series,
      meterParams,
    };
  }

  private groupSumByTime(samples: PowerSampleRow[]): Array<{ t: string; v: number }> {
    const map = new Map<string, number>();
    for (const s of samples) map.set(s.sample_time, (map.get(s.sample_time) ?? 0) + s.power_kw);
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([t, v]) => ({ t, v }));
  }

  private buildMeterParams(sub: PowerSampleRow[], mNo: string): Record<string, unknown> | null {
    if (sub.length === 0) return null;
    const latest = sub[sub.length - 1]; // 已按时间升序
    const powers = sub.map((s) => s.power_kw);
    const peak = Math.max(...powers);
    const avg = powers.reduce((a, b) => a + b, 0) / powers.length;
    return {
      meterNo: mNo,
      roomDetailAddr: latest.room_detail_addr,
      category: latest.category,
      multiplier: latest.multiplier,
      rate: latest.rate,
      ctRate: latest.ct_rate,
      ptRate: latest.pt_rate,
      commType: latest.comm_type,
      relayStatusDesc: latest.relay_status_desc,
      onlineStatusDesc: latest.online_status_desc,
      currentKw: latest.power_kw,
      peakKw: peak,
      avgKw: avg,
      realKwh: latest.real_kwh,
      sampleTime: latest.sample_time,
    };
  }

  // -------------------------------------------------------------------------
  // 表计台账（TAB 3）
  // -------------------------------------------------------------------------

  getMeters(category?: string, search?: string) {
    const data = this.getDashboardData();
    // 每表最新工况（对应 app.py 的 latest_meters）
    const latestByMeter = new Map<string, PowerSampleRow>();
    for (const s of this.getLatestSamples()) latestByMeter.set(s.meter_no, s);

    let rows = data.meters.map((m) => {
      const sample = latestByMeter.get(m.meter_no);
      return {
        meterNo: m.meter_no,
        roomDetailAddr: sample?.room_detail_addr ?? m.room_detail_addr ?? m.meter_no,
        category: sample?.category ?? m.category ?? '其他负荷',
        rate: m.rate ?? 1,
        multiplier: sample?.multiplier ?? m.rate ?? 1,
        ctRate: m.ct_rate ?? '',
        ptRate: m.pt_rate ?? '',
        realKwh: sample?.real_kwh ?? 0,
        totalKwh: sample?.total_kwh ?? 0,
        powerKw: sample?.power_kw ?? 0,
        relayStatusDesc: sample?.relay_status_desc ?? '',
        onlineStatusDesc: sample?.online_status_desc ?? '',
        commType: m.comm_type ?? '',
        imeiNo: m.imei_no ?? '',
        sampleTime: sample?.sample_time ?? '',
      };
    });

    if (category && category !== '全部分类') {
      rows = rows.filter((r) => r.category === category);
    }
    if (search && search.trim()) {
      const kw = search.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.roomDetailAddr.toLowerCase().includes(kw) || r.meterNo.toLowerCase().includes(kw),
      );
    }
    rows.sort((a, b) => (a.roomDetailAddr < b.roomDetailAddr ? -1 : 1));

    const categories = ['全部分类', ...Array.from(new Set(data.meters.map((m) => m.category ?? '其他负荷'))).sort()];
    return { rows, categories, meterCount: rows.length, total: data.meters.length };
  }

  // -------------------------------------------------------------------------
  // 告警（TAB 4）
  // -------------------------------------------------------------------------

  getAlarms() {
    const data = this.getDashboardData();
    return {
      rows: data.alarms.map((a) => ({
        meterNo: a.meter_no,
        alarmTime: a.alarm_time,
        alarmName: a.alarm_name,
        alarmCode: a.alarm_code,
        roomAddr: a.room_addr,
        alarmStatus: a.alarm_status,
        createdAt: a.created_at,
      })),
      activeCount: data.alarms.filter((a) => a.alarm_status === '告警中').length,
    };
  }
}
