import * as echarts from 'echarts';
import { EChart, EmptyChart } from '../EChart';
import { COLORS, MULTI_LINE_COLORS } from '../../theme';
import type { LoadCurveResponse } from '../../api/types';

function colorFor(mode: string, i: number): string {
  if (mode === 'total') return COLORS.teal;
  if (mode === 'single') return COLORS.blue;
  if (mode === 'category') return COLORS.orange;
  return MULTI_LINE_COLORS[i % MULTI_LINE_COLORS.length];
}

export function LoadCurveChart({ data }: { data: LoadCurveResponse }) {
  const { series } = data;
  if (!series.length || series.every((s) => !s.points.length)) {
    return <EmptyChart text="所选周期内暂无 15 分钟负荷采样数据" height={360} />;
  }

  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort();
  const singleSeries = series.length === 1;

  const periodSuffix = data.rangeLabel ? ` · ${data.rangeLabel}` : '';
  const titleText =
    data.mode === 'total'
      ? `全园区智能电表聚合负荷走势 (kW)${periodSuffix}`
      : data.mode === 'single'
        ? `回路负荷曲线: ${series[0]?.name ?? ''}${periodSuffix}`
        : data.mode === 'multi'
          ? `多回路实时负荷功率比对 (已选 ${series.length} 个回路)${periodSuffix}`
          : data.mode === 'category'
            ? `${series[0]?.name ?? ''} 实时总负荷走势 (kW)${periodSuffix}`
            : `实时负荷曲线${periodSuffix}`;

  const option: echarts.EChartsOption = {
    grid: { left: 52, right: 20, top: 56, bottom: 40 },
    title: {
      text: titleText,
      left: 'center',
      top: 0,
      textStyle: { fontSize: 14, color: COLORS.textGreen, fontWeight: 600 },
    },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `${Number(v).toFixed(2)} kW` },
    legend: singleSeries ? undefined : { bottom: 0, type: 'scroll' },
    xAxis: {
      type: 'category',
      data: times,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: COLORS.muted, fontSize: 11, formatter: (v: string) => v.slice(5, 16) },
    },
    yAxis: {
      type: 'value',
      name: '负荷功率 (kW)',
      nameTextStyle: { color: COLORS.muted },
      splitLine: { lineStyle: { color: '#edf4f0' } },
      axisLabel: { color: COLORS.muted },
    },
    series: series.map((s, i) => {
      const color = colorFor(data.mode, i);
      const showSymbol = s.points.length <= 96;
      return {
        name: s.name,
        type: 'line' as const,
        data: times.map((t) => s.points.find((p) => p.t === t)?.v ?? null),
        connectNulls: true,
        smooth: true,
        showSymbol,
        symbolSize: 6,
        lineStyle: { color, width: singleSeries ? 2.5 : 2 },
        itemStyle: { color },
        areaStyle: singleSeries
          ? {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: `${color}22` },
                  { offset: 1, color: `${color}00` },
                ],
              },
            }
          : undefined,
      };
    }),
  };
  return <EChart option={option} height={360} />;
}
