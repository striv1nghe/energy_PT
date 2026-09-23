import * as echarts from 'echarts';
import { EChart, EmptyChart } from '../EChart';
import { COLORS } from '../../theme';
import type { DailyUsagePoint } from '../../api/types';

export function DailyTrendChart({ data }: { data: DailyUsagePoint[] }) {
  if (!data.length) return <EmptyChart text="所选周期内暂无用电统计数据" />;

  const option: echarts.EChartsOption = {
    grid: { left: 52, right: 20, top: 24, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => `${Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`,
    },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.date.slice(5)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLORS.muted },
    },
    yAxis: {
      type: 'value',
      name: '用电量 (kWh)',
      nameTextStyle: { color: COLORS.muted },
      splitLine: { lineStyle: { color: '#edf4f0' } },
      axisLabel: { color: COLORS.muted },
    },
    series: [
      {
        type: 'line',
        data: data.map((d) => d.usage_kwh),
        smooth: true,
        symbolSize: 7,
        lineStyle: { color: COLORS.primary, width: 3 },
        itemStyle: { color: COLORS.primary },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(16,185,129,0.10)' },
              { offset: 1, color: 'rgba(16,185,129,0)' },
            ],
          },
        },
      },
    ],
  };
  return <EChart option={option} height={320} />;
}
