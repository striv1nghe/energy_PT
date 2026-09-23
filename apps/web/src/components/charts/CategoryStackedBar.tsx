import * as echarts from 'echarts';
import { EChart, EmptyChart } from '../EChart';
import { CATEGORY_COLORS, COLORS } from '../../theme';
import type { CategoryDailyPoint } from '../../api/types';

export function CategoryStackedBar({ data }: { data: CategoryDailyPoint[] }) {
  if (!data.length) return <EmptyChart text="暂无数据" />;

  const dates = [...new Set(data.map((d) => d.date))].sort();
  const cats = [...new Set(data.map((d) => d.category))];

  const option: echarts.EChartsOption = {
    color: CATEGORY_COLORS,
    grid: { left: 52, right: 20, top: 44, bottom: 32 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll', itemGap: 10 },
    xAxis: {
      type: 'category',
      data: dates.map((d) => d.slice(5)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLORS.muted },
    },
    yAxis: {
      type: 'value',
      name: 'kWh',
      nameTextStyle: { color: COLORS.muted },
      splitLine: { lineStyle: { color: '#edf4f0' } },
      axisLabel: { color: COLORS.muted },
    },
    series: cats.map((cat) => ({
      name: cat,
      type: 'bar',
      stack: 'total',
      emphasis: { focus: 'series' },
      data: dates.map((dt) => data.find((x) => x.date === dt && x.category === cat)?.usage_kwh ?? 0),
    })),
  };
  return <EChart option={option} height={320} />;
}
