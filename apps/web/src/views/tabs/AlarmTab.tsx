import { Table } from 'antd';
import { useAlarms } from '../../api/queries';
import type { AlarmRow } from '../../api/types';

export function AlarmTab() {
  const alarms = useAlarms();
  const rows = alarms.data?.rows ?? [];

  if (!alarms.isLoading && !rows.length) {
    return (
      <div className="section-box">
        <div className="section-title">🚨 突发设备告警与运维事件中心 (Tier-3)</div>
        <div className="section-sub">每 1 分钟轮询检索过流、断电、缺相、欠压、通信中断等异常事件</div>
        <div className="alarm-empty">
          <div style={{ fontSize: 32, marginBottom: 8 }}>🟢</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0e623f' }}>当前所有回路运行状态平稳，暂无未处理告警事件</div>
          <div style={{ fontSize: 12.5, color: '#638072', marginTop: 6 }}>
            系统持续每 60 秒轮询平台告警通道；如出现断电、跳闸或电气越限将在此处第一时间响应。
          </div>
        </div>
      </div>
    );
  }

  const columns = [
    { title: '电表号', dataIndex: 'meterNo', key: 'meterNo', width: 140 },
    { title: '告警发生时间', dataIndex: 'alarmTime', key: 'alarmTime', width: 180 },
    { title: '事件类型', dataIndex: 'alarmName', key: 'alarmName', width: 160 },
    { title: '点位位置', dataIndex: 'roomAddr', key: 'roomAddr', ellipsis: true },
    { title: '处理状态', dataIndex: 'alarmStatus', key: 'alarmStatus', width: 110 },
    { title: '记录入库时间', dataIndex: 'createdAt', key: 'createdAt', width: 180 },
  ];

  return (
    <div className="section-box">
      <div className="section-title">🚨 突发设备告警与运维事件中心 (Tier-3)</div>
      <div className="section-sub">每 1 分钟轮询检索过流、断电、缺相、欠压、通信中断等异常事件</div>
      <Table<AlarmRow> rowKey={(r) => `${r.meterNo}-${r.alarmTime}-${r.alarmName}`} columns={columns} dataSource={rows} size="small" loading={alarms.isLoading} />
    </div>
  );
}
