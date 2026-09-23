import { useMemo, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Button, Col, Input, message, Row, Select, Table } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useMeters } from '../../api/queries';
import type { MeterRow } from '../../api/types';

function relativeTime(sampleTime: string): string {
  if (!sampleTime) return '—';
  const then = new Date(sampleTime.replace(' ', 'T')).getTime();
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}个月前`;
  const year = Math.floor(month / 12);
  return `${year}年前`;
}

/** 可拖拽调整列宽的表格头单元格 */
function ResizableTitle(props: {
  onResize?: (width: number) => void;
  width?: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
}) {
  const { onResize, width, children, className, style, ...rest } = props;

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width ?? 0;
    const onMove = (ev: MouseEvent) => onResize?.(Math.max(60, startWidth + (ev.clientX - startX)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <th {...rest} className={className} style={{ ...style, position: 'relative' }}>
      {children}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute',
          top: 0,
          right: -4,
          width: 8,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 1,
        }}
      />
    </th>
  );
}

export function MeterTab() {
  const meters = useMeters();
  const [category, setCategory] = useState('全部分类');
  const [search, setSearch] = useState('');
  const [widths, setWidths] = useState<Record<string, number>>({});

  const categories = meters.data?.categories ?? ['全部分类'];

  const filtered = useMemo(() => {
    let rows = meters.data?.rows ?? [];
    if (category !== '全部分类') rows = rows.filter((r) => r.category === category);
    if (search.trim()) {
      const kw = search.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.roomDetailAddr.toLowerCase().includes(kw) || r.meterNo.toLowerCase().includes(kw),
      );
    }
    return [...rows].sort((a, b) => (a.roomDetailAddr < b.roomDetailAddr ? -1 : 1));
  }, [meters.data, category, search]);

  const w = (key: string, def: number) => widths[key] ?? def;
  const onResize = (key: string) => (width: number) => setWidths((prev) => ({ ...prev, [key]: width }));

  const downloadLedger = async () => {
    const res = await fetch('/api/export/ledger.csv', {
      headers: { Authorization: `Bearer ${localStorage.getItem('energy_token') ?? ''}` },
    });
    if (!res.ok) {
      message.error('导出失败，请稍后重试');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '电表实时台账.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = [
    {
      title: '电表编号',
      dataIndex: 'meterNo',
      key: 'meterNo',
      width: w('meterNo', 130),
      sorter: (a: MeterRow, b: MeterRow) => a.meterNo.localeCompare(b.meterNo),
      onHeaderCell: () => ({ width: w('meterNo', 130), onResize: onResize('meterNo') }),
    },
    {
      title: '安装位置 / 点位名称',
      dataIndex: 'roomDetailAddr',
      key: 'roomDetailAddr',
      width: w('roomDetailAddr', 260),
      ellipsis: true,
      sorter: (a: MeterRow, b: MeterRow) => a.roomDetailAddr.localeCompare(b.roomDetailAddr, 'zh-CN'),
      onHeaderCell: () => ({ width: w('roomDetailAddr', 260), onResize: onResize('roomDetailAddr') }),
    },
    {
      title: '用电分类',
      dataIndex: 'category',
      key: 'category',
      width: w('category', 100),
      sorter: (a: MeterRow, b: MeterRow) => a.category.localeCompare(b.category, 'zh-CN'),
      onHeaderCell: () => ({ width: w('category', 100), onResize: onResize('category') }),
    },
    {
      title: '折算真实底数(kWh)',
      dataIndex: 'realKwh',
      key: 'realKwh',
      width: w('realKwh', 150),
      align: 'right' as const,
      sorter: (a: MeterRow, b: MeterRow) => a.realKwh - b.realKwh,
      render: (v: number) => v.toFixed(2),
      onHeaderCell: () => ({ width: w('realKwh', 150), onResize: onResize('realKwh') }),
    },
    {
      title: '实时负荷(kW)',
      dataIndex: 'powerKw',
      key: 'powerKw',
      width: w('powerKw', 120),
      align: 'right' as const,
      sorter: (a: MeterRow, b: MeterRow) => a.powerKw - b.powerKw,
      render: (v: number) => v.toFixed(2),
      onHeaderCell: () => ({ width: w('powerKw', 120), onResize: onResize('powerKw') }),
    },
    {
      title: '继电器状态',
      dataIndex: 'relayStatusDesc',
      key: 'relayStatusDesc',
      width: w('relayStatusDesc', 110),
      sorter: (a: MeterRow, b: MeterRow) => a.relayStatusDesc.localeCompare(b.relayStatusDesc, 'zh-CN'),
      render: (v: string) => <span style={{ color: v.includes('通电') ? '#059669' : '#dc2626', fontWeight: 600 }}>{v}</span>,
      onHeaderCell: () => ({ width: w('relayStatusDesc', 110), onResize: onResize('relayStatusDesc') }),
    },
    {
      title: '在线状态',
      dataIndex: 'onlineStatusDesc',
      key: 'onlineStatusDesc',
      width: w('onlineStatusDesc', 90),
      sorter: (a: MeterRow, b: MeterRow) => a.onlineStatusDesc.localeCompare(b.onlineStatusDesc, 'zh-CN'),
      render: (v: string) => <span style={{ color: v === '在线' ? '#059669' : '#d97706' }}>{v}</span>,
      onHeaderCell: () => ({ width: w('onlineStatusDesc', 90), onResize: onResize('onlineStatusDesc') }),
    },
    {
      title: '最新采样时间',
      dataIndex: 'sampleTime',
      key: 'sampleTime',
      width: w('sampleTime', 140),
      sorter: (a: MeterRow, b: MeterRow) => a.sampleTime.localeCompare(b.sampleTime),
      render: (v: string) => relativeTime(v),
      onHeaderCell: () => ({ width: w('sampleTime', 140), onResize: onResize('sampleTime') }),
    },
  ];

  return (
    <div className="section-box">
      <div className="section-title">
        <span>⚡ 24 块智能物联电表台账与工况全览</span>
        <span style={{ fontSize: 12, color: '#059669', fontWeight: 400 }}>单表最新工况台账（每表一条，共 24 台在运）</span>
      </div>
      <div className="section-sub">包含最新底数读数及继电器通断状态</div>

      <Row gutter={12} style={{ marginBottom: 14 }}>
        <Col span={5}>
          <Select
            style={{ width: '100%' }}
            value={category}
            onChange={setCategory}
            options={categories.map((c) => ({ value: c, label: c }))}
          />
        </Col>
        <Col span={15}>
          <Input
            placeholder="输入点位名称（如：花房、空调、水泵、弱电间）或表号..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
          />
        </Col>
        <Col span={4} style={{ textAlign: 'right' }}>
          <Button type="primary" icon={<DownloadOutlined />} onClick={downloadLedger}>
            导出表计台账 (CSV)
          </Button>
        </Col>
      </Row>

      <Table<MeterRow>
        rowKey="meterNo"
        columns={columns}
        dataSource={filtered}
        pagination={false}
        size="small"
        loading={meters.isLoading}
        components={{ header: { cell: ResizableTitle } }}
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
}
