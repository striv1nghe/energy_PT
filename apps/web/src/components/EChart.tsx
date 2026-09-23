import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { COLORS } from '../theme';

export function EmptyChart({ text, height = 320 }: { text: string; height?: number }) {
  return (
    <div
      style={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS.muted,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

interface EChartProps {
  option: echarts.EChartsOption;
  height?: number;
}

/** 通用 ECharts 容器，自动 resize 与 dispose。 */
export function EChart({ option, height = 320 }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
