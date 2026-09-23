import { useState } from 'react';
import { Alert, Button, Col, DatePicker, Layout, Menu, Row, Space } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { LogoutOutlined } from '@ant-design/icons';
import { useKpi, useOverview } from '../api/queries';
import { KpiCard } from '../components/KpiCard';
import { OverviewTab } from './tabs/OverviewTab';
import { LoadCurveTab } from './tabs/LoadCurveTab';
import { MeterTab } from './tabs/MeterTab';
import { AlarmTab } from './tabs/AlarmTab';

const { Sider, Content } = Layout;
const { RangePicker } = DatePicker;

const TAB_ITEMS = [
  { key: 'overview', label: '📊 能源总览与趋势' },
  { key: 'load', label: '📈 实时负荷与单表曲线' },
  { key: 'meters', label: '⚡ 表计台账与工况全览' },
  { key: 'alarms', label: '🚨 突发告警监测中心' },
];

function fmt(n: number, digits = 1): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function Dashboard() {
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>([dayjs().subtract(6, 'day'), dayjs()]);
  const [activeTab, setActiveTab] = useState('overview');

  const start = range?.[0]?.format('YYYY-MM-DD');
  const end = range?.[1]?.format('YYYY-MM-DD');

  const kpi = useKpi(start, end);
  const overview = useOverview();
  const queryClient = useQueryClient();

  const k = kpi.data;
  const o = overview.data;

  const trendNode =
    k && k.trend.diff !== null && k.trend.diff !== 0 ? (
      <>
        {k.trend.direction === 'down' ? (
          <span className="trend-tag-down">环比 {k.trend.pct?.toFixed(1)}% ↓</span>
        ) : (
          <span className="trend-tag-up">环比 +{k.trend.pct?.toFixed(1)}% ↑</span>
        )}
        {k.trend.direction === 'down'
          ? `较昨日省 ${Math.abs(k.trend.diff!).toFixed(1)} 度`
          : `较昨日增 ${k.trend.diff!.toFixed(1)} 度`}
      </>
    ) : (
      '暂无昨日基准可比'
    );

  const alarmActive = (k?.alarmCount ?? 0) > 0;

  const logout = () => {
    localStorage.removeItem('energy_token');
    window.dispatchEvent(new Event('energy-auth-expired'));
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'load':
        return <LoadCurveTab start={start} end={end} />;
      case 'meters':
        return <MeterTab />;
      case 'alarms':
        return <AlarmTab />;
      case 'overview':
      default:
        return <OverviewTab start={start} end={end} />;
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={288} className="energy-sider" breakpoint="lg" collapsedWidth={0}>
        <div className="sider-title">🌿 绿城能源平台</div>
        <div className="sider-caption">园区能碳智控运营中心 · 宁波慈溪凤起潮鸣</div>

        <div className="sider-block">
          <h4>📅 数据显示范围</h4>
          <RangePicker
            value={range}
            onChange={(val) => setRange(val)}
            format="YYYY-MM-DD"
            size="small"
            allowClear
            disabledDate={(current) => current.isAfter(dayjs(), 'day')}
            style={{ width: '100%' }}
            presets={[
              { label: '当日', value: [dayjs(), dayjs()] },
              { label: '近 7 天', value: [dayjs().subtract(6, 'day'), dayjs()] },
              { label: '近 14 天', value: [dayjs().subtract(13, 'day'), dayjs()] },
              { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] },
              { label: '最近一季度', value: [dayjs().subtract(3, 'month'), dayjs()] },
              { label: '最近一年', value: [dayjs().subtract(1, 'year'), dayjs()] },
            ]}
          />
        </div>

        <div className="sider-block">
          <h4>🧭 功能导航</h4>
          <Menu
            mode="inline"
            selectedKeys={[activeTab]}
            onClick={({ key }) => setActiveTab(key)}
            items={TAB_ITEMS}
            style={{ background: 'transparent', border: 'none' }}
          />
        </div>

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Button
            block
            onClick={() => queryClient.invalidateQueries()}
            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#ebf7f0' }}
          >
            🔄 立即刷新数据
          </Button>
          <Button
            block
            icon={<LogoutOutlined />}
            onClick={logout}
            style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#ffd6d6' }}
          >
            退出登录
          </Button>
        </Space>
      </Sider>

      <Content style={{ padding: '22px 26px 40px' }}>
        {o?.disk?.alarm && (
          <Alert
            type="error"
            showIcon
            banner
            message={`磁盘空间告警：数据库大小 ${fmtBytes(o.disk.dbBytes)} 已达磁盘总空间 ${fmtBytes(o.disk.totalBytes)} 的 ${o.disk.usagePercent.toFixed(1)}%（阈值 ${o.disk.thresholdPercent}%），请及时清理或扩容磁盘。`}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 顶部标题与状态栏 */}
        <Row align="middle" justify="space-between">
          <Col>
            <div className="dash-title">🌿 绿城园区能源数据监控中心</div>
            <div className="dash-subtitle">
              项目：<b>{o?.project?.project_name ?? '宁波慈溪凤起潮鸣'}</b> · 园区智能电表实时监控
            </div>
          </Col>
          <Col>
            <div
              className="status-badge"
              style={o?.disk?.alarm ? { background: '#fef2f2', borderColor: '#fecaca', color: '#dc2626' } : undefined}
            >
              <span className="pulse-dot" style={o?.disk?.alarm ? { background: '#dc2626' } : undefined} />
              <span>{o?.disk?.alarm ? '磁盘空间告警' : '系统运行正常'}</span>
            </div>
          </Col>
        </Row>

        {/* KPI 卡片阵列 */}
        <Row gutter={14} style={{ marginTop: 16 }}>
          <Col flex="1">
            <KpiCard title="周期总用电量" value={`${fmt(k?.totalUsage ?? 0)} kWh`} detail={`统计跨度 ${k?.statDays ?? 0} 个自然日`} accent="#0d8250" />
          </Col>
          <Col flex="1">
            <KpiCard title="最新日用电量" value={`${fmt(k?.latestDaily ?? 0)} kWh`} detail={trendNode} accent="#15803d" />
          </Col>
          <Col flex="1">
            <KpiCard title="估算总电费成本" value={`¥ ${fmt(k?.totalCost ?? 0)}`} detail={`参考单价 ${(k?.electricityPrice ?? 0.558).toFixed(3)} 元/度`} accent="#d97706" />
          </Col>
          <Col flex="1">
            <KpiCard title="等效碳排放基准" value={`${fmt(k?.totalEmission ?? 0, 2)} 吨`} detail="折算 0.581 kg CO₂/kWh" accent="#0284c7" />
          </Col>
          <Col flex="1">
            <KpiCard
              title="表计工况与告警"
              value={`${k?.meterCount ?? 24} 块全部在运`}
              detail={alarmActive ? `${k?.alarmCount} 起待处理` : `${k?.onlineCount ?? 24}/${k?.meterCount ?? 24} 块在线 · 运行平稳`}
              accent={alarmActive ? '#e11d48' : '#059669'}
            />
          </Col>
        </Row>

        {/* 当前选项卡内容 */}
        <div style={{ marginTop: 16 }}>{renderTab()}</div>
      </Content>
    </Layout>
  );
}
