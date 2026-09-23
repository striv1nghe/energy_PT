/**
 * 前后端共享的业务常量与类型定义。
 * 常量来源于原 app.py / sync_energy_to_sqlite.py，保持数值与语义一致。
 */

/** 华东区域电网基准碳排因子 (吨 CO2 / kWh) */
export const EMISSION_FACTOR_TON_PER_KWH = 0.000581;

/** 浙江省一般工商业综合参考电价 (元 / kWh) */
export const DEFAULT_ELECTRICITY_PRICE = 0.558;

/** 目标项目编号 */
export const DEFAULT_PROJECT_ID = '202607020000000001';

/** 目标项目名称 */
export const DEFAULT_PROJECT_NAME = '宁波慈溪凤起潮鸣';

/** 表计总量 */
export const DEFAULT_METER_COUNT = 24;

/** 统计周期选项：显示标签 -> 天数（null 表示全部历史） */
export type PeriodKey = 'today' | '7d' | '14d' | '30d' | 'all';

export const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string; days: number | null }> = [
  { key: 'today', label: '今日 (实时)', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '14d', label: '近 14 天', days: 14 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部历史', days: null },
];

/** 负荷曲线分析视角 */
export type LoadCurveMode = 'total' | 'single' | 'multi' | 'category';
