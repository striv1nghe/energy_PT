import * as echarts from 'echarts';
import { EChart, EmptyChart } from '../EChart';
import { CATEGORY_COLORS } from '../../theme';
import type { CategoryDailyPoint } from '../../api/types';

export function CategoryDonut({ data }: { data: CategoryDailyPoint[] }) {
  if (!data.length) return <EmptyChart text="暂无分类数据" />;

  const map = new Map<string, number>();
  for (const d of data) map.set(d.category, (map.get(d.category) ?? 0) + d.usage_kwh);
  const list = [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  const option: echarts.EChartsOption = {
    color: CATEGORY_COLORS,
    tooltip: {
      trigger: 'item',
      valueFormatter: (v) => `${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} kWh`,
    },
    // 分类名称放到底部滚动图例，避免外部标签溢出绘制区域
    legend: {
      bottom: 0,
      type: 'scroll',
      icon: 'circle',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { fontSize: 11, color: '#4b665a' },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '72%'],
        center: ['50%', '40%'],
        data: list,
        label: {
          show: true,
          position: 'inside',
          formatter: '{d}%',
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 600,
        },
        labelLine: { show: false },
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
      },
    ],
  };
  return <EChart option={option} height={320} />;
}
