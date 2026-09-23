import { describe, expect, it } from 'vitest';
import { classifyMeter } from '../../common/classify';
import {
  computeDailyUsage,
  computePowerSamples,
  normalizeOnlineStatus,
  normalizeRelayStatus,
  parseLocalDateTime,
  type LoadSampleRow,
  type MeterReadingRow,
} from './compute';

const reading = (meter_no: string, data_time: string, real_kwh: number, category = '空调系统', room = 'x'): MeterReadingRow => ({
  meter_no,
  data_time,
  total_kwh: real_kwh,
  multiplier: 1,
  real_kwh,
  category,
  room_detail_addr: room,
});

const sample = (meter_no: string, sample_time: string, real_kwh: number): LoadSampleRow => ({
  meter_no,
  sample_time,
  total_kwh: real_kwh,
  multiplier: 1,
  real_kwh,
  relay_status: '00120001',
  online_status: '正常',
  category: '空调系统',
  room_detail_addr: 'x',
  rate: 1,
  ct_rate: '1/1',
  pt_rate: '1/1',
  comm_type: '电信NB-IoT',
  imei_no: 'imei',
});

describe('classifyMeter', () => {
  it('按关键词归集（顺序敏感）', () => {
    expect(classifyMeter('示范区-电表-花房-主')).toBe('花房');
    expect(classifyMeter('示范区-电表-花房-空调')).toBe('空调系统');
    expect(classifyMeter('示范区-电表-景观-水泵')).toBe('给排水系统');
    expect(classifyMeter('示范区-电表-大厅照明-总开')).toBe('照明系统');
    expect(classifyMeter('示范区-电表-弱电间-总')).toBe('其他负荷');
  });
});

describe('normalize 状态', () => {
  it('继电器状态', () => {
    expect(normalizeRelayStatus('00120001')).toBe('通电 (合闸)');
    expect(normalizeRelayStatus('00120002')).toBe('断电 (拉闸)');
    expect(normalizeRelayStatus('合闸')).toBe('通电 (合闸)');
    expect(normalizeRelayStatus(null)).toBe('合闸');
  });
  it('在线状态', () => {
    expect(normalizeOnlineStatus('正常')).toBe('在线');
    expect(normalizeOnlineStatus('在线')).toBe('在线');
    expect(normalizeOnlineStatus('离线')).toBe('离线');
    expect(normalizeOnlineStatus(null)).toBe('正常');
  });
});

describe('parseLocalDateTime', () => {
  it('按本地时区解析', () => {
    const d = parseLocalDateTime('2026-09-18 08:30:15');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(18);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(15);
  });
});

describe('computeDailyUsage', () => {
  it('计算相邻日正向增量并聚合', () => {
    const rows: MeterReadingRow[] = [
      reading('A', '2026-09-01 00:00:00', 100),
      reading('A', '2026-09-02 00:00:00', 110),
      reading('A', '2026-09-03 00:00:00', 105), // 回落 -> 0
      reading('B', '2026-09-02 00:00:00', 50),
      reading('B', '2026-09-03 00:00:00', 80),
    ];
    const { usageDaily } = computeDailyUsage(rows);
    const byDate = Object.fromEntries(usageDaily.map((d) => [d.date, d.usage_kwh]));
    expect(byDate['2026-09-02']).toBeCloseTo(10, 6);
    expect(byDate['2026-09-03']).toBeCloseTo(30, 6);
    expect(byDate['2026-09-01']).toBeUndefined(); // 首日无基准
  });

  it('同一表同一日保留最后一条', () => {
    const rows: MeterReadingRow[] = [
      reading('A', '2026-09-01 00:00:00', 100),
      reading('A', '2026-09-01 00:00:00', 100), // 重复
      reading('A', '2026-09-02 00:00:00', 112),
    ];
    const { usageDaily } = computeDailyUsage(rows);
    expect(usageDaily[0].usage_kwh).toBeCloseTo(12, 6);
  });

  it('0 值缺口不产生恢复跳变（数据采集异常保护）', () => {
    const rows: MeterReadingRow[] = [
      reading('A', '2026-09-16 00:00:00', 100),
      reading('A', '2026-09-17 00:00:00', 0), // 缺口
      reading('A', '2026-09-18 00:00:00', 0), // 缺口
      reading('A', '2026-09-19 00:00:00', 160), // 恢复
    ];
    const { usageDaily } = computeDailyUsage(rows);
    const byDate = Object.fromEntries(usageDaily.map((d) => [d.date, d.usage_kwh]));
    // 恢复日增量 = 160 - 100 = 60，而非 160 - 0 = 160
    expect(byDate['2026-09-19']).toBeCloseTo(60, 6);
    expect(byDate['2026-09-17']).toBeUndefined();
    expect(byDate['2026-09-18']).toBeUndefined();
  });
});

describe('computePowerSamples', () => {
  it('跳变后跟随持平段时，增量被前向分摊（批式补记平滑）', () => {
    const rows: LoadSampleRow[] = [
      sample('M', '2026-09-18 00:00:00', 100),
      sample('M', '2026-09-18 00:15:00', 102.45), // +2.45 正常
      sample('M', '2026-09-18 00:30:00', 114.7), // +12.25 批式补记
      sample('M', '2026-09-18 00:45:00', 114.7), // 持平
      sample('M', '2026-09-18 01:00:00', 114.7), // 持平
      sample('M', '2026-09-18 01:15:00', 114.7), // 持平
      sample('M', '2026-09-18 01:30:00', 114.7), // 持平
      sample('M', '2026-09-18 01:45:00', 117.16), // +2.46 恢复
    ];
    const out = computePowerSamples(rows);
    // 12.25 kWh 分摊到 00:30~01:30 共 5 个点 => 12.25/1.25h = 9.8 kW
    expect(out.map((r) => r.power_kw)).toEqual([0, 9.8, 9.8, 9.8, 9.8, 9.8, 9.8, 9.84]);
  });

  it('采样缺口(>15分钟)按真实缺口时长折算', () => {
    const rows: LoadSampleRow[] = [
      sample('M', '2026-09-01 00:00:00', 100),
      sample('M', '2026-09-02 06:00:00', 101), // 30h 缺口，+1 kWh => 0.03 kW
      sample('M', '2026-09-02 06:15:00', 103), // +2 kWh / 0.25h = 8 kW
    ];
    const out = computePowerSamples(rows);
    expect(out.map((r) => r.power_kw)).toEqual([0, 0.03, 8]);
  });

  it('常规连续 15 分钟上报保持原有功率（无持平段）', () => {
    const rows: LoadSampleRow[] = [
      sample('M', '2026-09-18 00:00:00', 100),
      sample('M', '2026-09-18 00:15:00', 101), // +1 / 0.25h = 4 kW
      sample('M', '2026-09-18 00:30:00', 102), // +1 / 0.25h = 4 kW
    ];
    const out = computePowerSamples(rows);
    expect(out.map((r) => r.power_kw)).toEqual([0, 4, 4]);
  });
});
