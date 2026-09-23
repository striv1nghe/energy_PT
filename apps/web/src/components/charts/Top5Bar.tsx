import * as echarts from 'echarts';
import { EChart, EmptyChart } from '../EChart';
import { COLORS } from '../../theme';
import type { TopConsumer } from '../../api/types';

function lerpColor(c1: string, c2: string, t: number): string {
  const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const a = p(c1);
  const b = p(c2);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function Top5Bar({ data }: { data: TopConsumer[] }) {
  if (!data.length) return <EmptyChart text="暂无电表数据" height={260} />;

  const sorted = [...data].sort((a, b) => a.total - b.total);
  const max = sorted[sorted.length - 1].total;
  const min = sorted[0].total;

  const option: echarts.EChartsOption = {
    grid: { left: 12, right: 80, top: 10, bottom: 10, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => `${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} kWh`,
    },
    xAxis: {
      type: 'value',
      name: 'kWh',
      nameTextStyle: { fontSize: 11 },
      splitLine: { lineStyle: { color: '#f0f4f1' } },
      axisLabel: { color: COLORS.muted, fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: sorted.map((d) => d.room_detail_addr),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: COLORS.textGreen, fontSize: 12 },
    },
    series: [
      {
        type: 'bar',
        data: sorted.map((d) => ({
          value: d.total,
          itemStyle: { color: lerpColor('#a7f3d0', '#059669', max > min ? (d.total - min) / (max - min) : 0.5), borderRadius: [0, 6, 6, 0] },
        })),
        label: {
          show: true,
          position: 'right',
          formatter: (p) => `${Number(p.value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} kWh`,
          color: '#334155',
          fontSize: 12,
        },
      },
    ],
  };
  return <EChart option={option} height={260} />;
}
