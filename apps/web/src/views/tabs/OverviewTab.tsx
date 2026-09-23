import { Col, Row, Table } from 'antd';
import { useDailyUsage, useKpi, useOverview } from '../../api/queries';
import { DailyTrendChart } from '../../components/charts/DailyTrendChart';
import { CategoryStackedBar } from '../../components/charts/CategoryStackedBar';
import { CategoryDonut } from '../../components/charts/CategoryDonut';
import { Top5Bar } from '../../components/charts/Top5Bar';
import type { CategorySummary } from '../../api/types';

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function OverviewTab({ start, end }: { start?: string; end?: string }) {
  const daily = useDailyUsage(start, end);
  const kpi = useKpi(start, end);
  const overview = useOverview();

  const data = daily.data;
  const k = kpi.data;
  const proj = overview.data?.project;

  const topCat = data?.categorySummary?.[0]?.category ?? '空调系统';
  const trend =
    k?.trend && k.trend.diff !== null && k.trend.diff !== 0
      ? k.trend.direction === 'down'
        ? `环比 ${k.trend.pct?.toFixed(1)}% ↓ 较昨日省 ${Math.abs(k.trend.diff).toFixed(1)} 度`
        : `环比 +${k.trend.pct?.toFixed(1)}% ↑ 较昨日增 ${k.trend.diff.toFixed(1)} 度`
      : '暂无昨日基准可比';

  const catColumns = [
    { title: '用电分类', dataIndex: 'category', key: 'category' },
    {
      title: '累计用电量 (kWh)',
      dataIndex: 'usageKwh',
      key: 'usageKwh',
      align: 'right' as const,
      render: (v: number) => fmt(v),
    },
    {
      title: '估算电费 (元)',
      dataIndex: 'cost',
      key: 'cost',
      align: 'right' as const,
      render: (v: number) => `¥ ${fmt(v)}`,
    },
    {
      title: '用电占比',
      dataIndex: 'ratio',
      key: 'ratio',
      width: 220,
      render: (v: number) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, background: '#e9f2ec', height: 6, borderRadius: 3 }}>
            <div style={{ width: `${Math.min(100, v)}%`, background: '#0d8250', height: 6, borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 12, color: '#4b665a', width: 48, textAlign: 'right' }}>{v.toFixed(1)}%</span>
        </div>
      ),
    },
  ];

  return (
    <div>
      <Row gutter={20}>
        <Col xs={24} lg={18}>
          <div className="section-box">
            <div className="section-title">
              <span>📈 园区总日用电量趋势 (Daily Freeze)</span>
              <span style={{ fontSize: 12, color: '#88a296', fontWeight: 400 }}>单位: kWh / 日</span>
            </div>
            <div className="section-sub">统计 24 块智能物联电表相邻日冻结底数真实电量增量（自动乘互感器倍率）</div>
            <DailyTrendChart data={data?.usageDaily ?? []} />
          </div>

          <div className="section-box">
            <div className="section-title">
              <span>📊 场景分类日用电堆叠分布</span>
              <span style={{ fontSize: 12, color: '#88a296', fontWeight: 400 }}>按主要用电场景区分</span>
            </div>
            <div className="section-sub">清晰比对每日空调、儿童空间、给排水、照明等各用电负荷的波动情况</div>
            <CategoryStackedBar data={data?.categoryDaily ?? []} />
          </div>
        </Col>

        <Col xs={24} lg={6}>
          <div className="side-info-card">
            <div className="side-info-title">场景能耗结构占比</div>
            <CategoryDonut data={data?.categoryDaily ?? []} />
          </div>

          <div className="side-info-card">
            <div className="side-info-title">园区运行摘要</div>
            <div className="info-row"><span>目标项目</span><span className="info-val">{proj?.project_name ?? '宁波慈溪凤起潮鸣'}</span></div>
            <div className="info-row"><span>在运电表</span><span className="info-val">{proj?.meter_count ?? 24} 台</span></div>
            <div className="info-row"><span>日冻结周期</span><span className="info-val">{data?.earliestDate ?? '—'} 至 {data?.newestDate ?? '—'}</span></div>
            <div className="info-row"><span>单日最高峰值</span><span className="info-val">{fmt(k?.peakDaily ?? 0)} kWh</span></div>
          </div>

          <div className="side-info-card">
            <div className="side-info-title">💡 能耗诊断与节能洞察</div>
            <div style={{ color: '#557265', fontSize: 12.5, lineHeight: 1.75 }}>
              • <b>负荷主体</b>：当前周期内 <b>{topCat}</b> 为园区最大能耗来源。<br />
              • <b>环比走势</b>：{trend}。<br />
              • <b>节能建议</b>：建议在营业前 30 分钟分批开启主要空调回路，避开午间 11:00~13:00 尖峰电价时段的超大负荷重叠，可显著降低综合电费。
            </div>
          </div>
        </Col>
      </Row>

      <Row gutter={20}>
        <Col xs={24} lg={10}>
          <div className="section-box">
            <div className="section-title">🔥 周期重点耗电回路 Top 5</div>
            <div className="section-sub">园区用电负荷最高的重点回路排名</div>
            <Top5Bar data={data?.topConsumers ?? []} />
          </div>
        </Col>
        <Col xs={24} lg={14}>
          <div className="section-box">
            <div className="section-title">📋 场景用电明细与占比排行</div>
            <div className="section-sub">各分类用电总量与占比（点击表头可重新排序）</div>
            <Table<CategorySummary>
              rowKey="category"
              columns={catColumns}
              dataSource={data?.categorySummary ?? []}
              pagination={false}
              size="small"
              loading={daily.isLoading}
            />
          </div>
        </Col>
      </Row>
    </div>
  );
}
