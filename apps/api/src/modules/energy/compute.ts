/**
 * 核心聚合计算纯函数 —— 逐项移植自 app.py 的 load_dashboard_data。
 * 保持与 pandas 原实现等价的语义，便于单元测试与交叉验证。
 */

/** 日冻结读数行（已 JOIN meters 得到分类与点位） */
export interface MeterReadingRow {
  meter_no: string;
  data_time: string;
  total_kwh: number;
  multiplier: number;
  real_kwh: number;
  category: string;
  room_detail_addr: string;
}

/** 15 分钟负荷采样行（已 JOIN meters 得到分类与点位） */
export interface LoadSampleRow {
  meter_no: string;
  sample_time: string;
  total_kwh: number;
  multiplier: number;
  real_kwh: number;
  relay_status: string;
  online_status: string;
  category: string;
  room_detail_addr: string;
  rate: number;
  ct_rate: string;
  pt_rate: string;
  comm_type: string;
  imei_no: string;
}

export interface MeterDailyPoint {
  date: string;
  meter_no: string;
  category: string;
  room_detail_addr: string;
  usage_kwh: number;
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

export interface PowerSampleRow extends LoadSampleRow {
  datetime: Date;
  power_kw: number;
  relay_status_desc: string;
  online_status_desc: string;
}

/**
 * 将 "YYYY-MM-DD HH:MM:SS" 字符串按本地时区解析为 Date。
 * 不使用 new Date(str) 以避免实现差异，保证时区语义一致。
 */
export function parseLocalDateTime(s: string): Date {
  const [datePart, timePart = '00:00:00'] = String(s).split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
}

/** 继电器状态规范化 —— 对应 app.py 的 relay_status_desc */
export function normalizeRelayStatus(x: unknown): string {
  const s = x == null ? '' : String(x);
  if (['00120001', '合闸', '1'].includes(s)) return '通电 (合闸)';
  if (['00120002', '拉闸', '0'].includes(s)) return '断电 (拉闸)';
  return s || '合闸';
}

/** 在线状态规范化 —— 对应 app.py 的 online_status_desc */
export function normalizeOnlineStatus(x: unknown): string {
  const s = x == null ? '' : String(x);
  if (['正常', '在线', '0', '1'].includes(s)) return '在线';
  return s || '正常';
}

/** 保留两位小数，消除浮点累加噪声。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cmpMeterThenDate(a: { meter_no: string; date: string }, b: { meter_no: string; date: string }): number {
  if (a.meter_no !== b.meter_no) return a.meter_no < b.meter_no ? -1 : 1;
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

export interface DailyUsageResult {
  meterDaily: MeterDailyPoint[];
  usageDaily: DailyUsagePoint[];
  categoryDaily: CategoryDailyPoint[];
}

/**
 * 日用电量计算：相邻冻结日 real_kwh 正向增量。
 * 对应 pandas: drop_duplicates(keep=last) -> sort -> groupby(meter_no).diff().clip(lower=0) -> dropna。
 */
export function computeDailyUsage(rows: MeterReadingRow[]): DailyUsageResult {
  const dated = rows.map((r) => ({ ...r, date: String(r.data_time).slice(0, 10) }));

  // 去重：同一 (meter_no, 日期) 保留最后一条
  const dedup = new Map<string, (typeof dated)[number]>();
  for (const r of dated) dedup.set(`${r.meter_no}\u0000${r.date}`, r);
  const clean = [...dedup.values()].sort(cmpMeterThenDate);

  const meterDaily: MeterDailyPoint[] = [];
  // 最近一次「有效」底数（real_kwh > 0）。0/负值视为日冻结数据缺口，不参与增量计算，
  // 避免把缺口期累计电量一次性计入恢复当日（数据采集异常保护）。
  const prevByMeter = new Map<string, number>();
  for (const r of clean) {
    if (r.real_kwh <= 0) continue; // 数据缺口：既不作为基准，也不产生增量
    const prev = prevByMeter.get(r.meter_no);
    prevByMeter.set(r.meter_no, r.real_kwh);
    if (prev === undefined) continue; // 首条有效读数无基准，忽略
    const usage = Math.max(0, r.real_kwh - prev);
    meterDaily.push({
      date: r.date,
      meter_no: r.meter_no,
      category: r.category,
      room_detail_addr: r.room_detail_addr,
      usage_kwh: round2(usage),
    });
  }

  const usageByDate = new Map<string, number>();
  const categoryByDate = new Map<string, number>();
  for (const p of meterDaily) {
    usageByDate.set(p.date, (usageByDate.get(p.date) ?? 0) + p.usage_kwh);
    const ck = `${p.date}\u0000${p.category}`;
    categoryByDate.set(ck, (categoryByDate.get(ck) ?? 0) + p.usage_kwh);
  }

  const usageDaily: DailyUsagePoint[] = [...usageByDate.entries()]
    .map(([date, usage_kwh]) => ({ date, usage_kwh: round2(usage_kwh) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const categoryDaily: CategoryDailyPoint[] = [...categoryByDate.entries()]
    .map(([k, usage_kwh]) => {
      const [date, category] = k.split('\u0000');
      return { date, category, usage_kwh: round2(usage_kwh) };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.category < b.category ? -1 : 1));

  return { meterDaily, usageDaily, categoryDaily };
}

/**
 * 15 分钟负荷功率推算（含「批式补记」平滑）。
 *
 * 上游 NB-IoT 电表并非严格每 15 分钟上报，而是「间歇上报 + 平台补位」：
 * 未上报期间底数保持不变（持平），下一次上报时一次性补记累计增量。若按固定
 * 15 分钟直接做差，会把补记增量放大成假峰，因此：
 *   - 常规 15 分钟间隔：把增量「前向分摊」到随后的持平区间（直到下一次底数变化）；
 *   - 采样缺口（间隔 > 15 分钟）：增量是缺口期间累计的，按真实缺口时长折算。
 */
export function computePowerSamples(rows: LoadSampleRow[]): PowerSampleRow[] {
  const withDt = rows.map((r) => ({ ...r, datetime: parseLocalDateTime(r.sample_time) }));
  withDt.sort((a, b) => {
    if (a.meter_no !== b.meter_no) return a.meter_no < b.meter_no ? -1 : 1;
    return a.datetime.getTime() - b.datetime.getTime();
  });

  const groups = new Map<string, (typeof withDt)[number][]>();
  for (const r of withDt) {
    const arr = groups.get(r.meter_no) ?? [];
    arr.push(r);
    groups.set(r.meter_no, arr);
  }

  const result: PowerSampleRow[] = [];
  for (const list of groups.values()) {
    const n = list.length;
    const powers = new Array<number>(n).fill(0);

    // 底数较上一点上升的「变更点」索引
    const changes: number[] = [];
    for (let i = 1; i < n; i++) {
      if (list[i].real_kwh > list[i - 1].real_kwh) changes.push(i);
    }

    for (let k = 0; k < changes.length; k++) {
      const i = changes[k];
      const delta = list[i].real_kwh - list[i - 1].real_kwh;
      if (delta <= 0) continue;
      const hours = (list[i].datetime.getTime() - list[i - 1].datetime.getTime()) / 3_600_000;

      if (hours > 0.26) {
        // 采样缺口：增量是缺口期间累计的，按真实缺口时长折算，避免放大
        powers[i] = delta / hours;
      } else {
        // 常规 15 分钟间隔：前向分摊到随后的持平区间（含变更点本身）
        const j = k + 1 < changes.length ? changes[k + 1] : n;
        const spread = j - i; // 覆盖点数
        const power = delta / (spread * 0.25);
        for (let p = i; p < j; p++) powers[p] = power;
      }
    }

    for (let i = 0; i < n; i++) {
      const row = list[i];
      result.push({
        ...row,
        power_kw: round2(powers[i]),
        relay_status_desc: normalizeRelayStatus(row.relay_status),
        online_status_desc: normalizeOnlineStatus(row.online_status),
      });
    }
  }

  return result;
}
