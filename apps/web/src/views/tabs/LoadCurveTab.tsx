import { useMemo, useState } from 'react';
import { Col, Radio, Row, Select, Statistic } from 'antd';
import { useLoadCurve, useMeters } from '../../api/queries';
import { LoadCurveChart } from '../../components/charts/LoadCurveChart';
import type { LoadCurveResponse } from '../../api/types';

const MODE_OPTIONS = [
  { value: 'total', label: '🏢 全园区实时总负荷走势' },
  { value: 'single', label: '🔍 单回路深度下钻' },
  { value: 'multi', label: '⚖️ 多回路同轴对比' },
  { value: 'category', label: '🗂️ 场景分类总负荷走势' },
];

export function LoadCurveTab({ start, end }: { start?: string; end?: string }) {
  const [mode, setMode] = useState('total');
  const [singleMeter, setSingleMeter] = useState<string | undefined>();
  const [multiMeters, setMultiMeters] = useState<string[]>([]);
  const [category, setCategory] = useState<string | undefined>();

  const meters = useMeters();
  const meterOptions = useMemo(
    () =>
      (meters.data?.rows ?? []).map((m) => ({
        value: m.meterNo,
        label: `${m.roomDetailAddr} (${Math.round(m.rate)}x | ${m.meterNo})`,
      })),
    [meters.data],
  );

  // 默认选中首块电表 / 前三块
  const effectiveSingle = singleMeter ?? meterOptions[0]?.value;
  const effectiveMulti = multiMeters.length ? multiMeters : meterOptions.slice(0, 3).map((o) => o.value);

  const categories = (meters.data?.categories ?? []).filter((c) => c !== '全部分类');
  const effectiveCategory = category ?? categories[0];

  const metersParam = mode === 'single' ? (effectiveSingle ? [effectiveSingle] : []) : mode === 'multi' ? effectiveMulti : [];
  const curve = useLoadCurve({
    start,
    end,
    mode,
    meters: mode === 'single' || mode === 'multi' ? metersParam : undefined,
    category: mode === 'category' ? effectiveCategory : undefined,
  });

  const data = curve.data;
  const emptyCurve: LoadCurveResponse = {
    mode,
    rangeLabel: '',
    latestTime: '',
    currentTotalKw: 0,
    readyCount: 0,
    periodPeakKw: 0,
    periodAvgKw: 0,
    series: [],
    meterParams: null,
  };

  return (
    <div className="section-box">
      <div className="section-title">
        <span>📈 15 分钟级电表实时负荷曲线工作台 (Real-time Load Curves)</span>
        <span style={{ fontSize: 12, color: '#88a296', fontWeight: 400 }}>采样周期: 每 15 分钟推算功率 (kW)</span>
      </div>
      <div className="section-sub">
        根据智能电表相邻 15 分钟瞬时底数增量实时换算等效平均负荷功率：P = ΔE / Δt。支持全园大盘、单回路下钻及多回路同轴对比。
      </div>

      <Radio.Group
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        options={MODE_OPTIONS}
        optionType="button"
        buttonStyle="solid"
        style={{ marginBottom: 14 }}
      />

      <Row gutter={16} align="middle" style={{ marginBottom: 12 }}>
        {mode === 'single' && (
          <Col span={12}>
            <Select
              style={{ width: '100%' }}
              value={effectiveSingle}
              onChange={setSingleMeter}
              options={meterOptions}
              placeholder="选择要下钻的电表回路"
              showSearch
              optionFilterProp="label"
            />
          </Col>
        )}
        {mode === 'multi' && (
          <Col span={12}>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              value={effectiveMulti}
              onChange={setMultiMeters}
              options={meterOptions}
              placeholder="选择要同轴对比的电表回路 (建议 2~5 个)"
              maxTagCount="responsive"
              optionFilterProp="label"
            />
          </Col>
        )}
        {mode === 'category' && (
          <Col span={12}>
            <Select
              style={{ width: '100%' }}
              value={effectiveCategory}
              onChange={setCategory}
              options={categories.map((c) => ({ value: c, label: c }))}
              placeholder="选择用电场景"
            />
          </Col>
        )}

        <Col span={4}>
          <Statistic title="最新采样时点" value={data?.latestTime?.slice(11) ?? '—'} valueStyle={{ fontSize: 18 }} />
        </Col>
        <Col span={4}>
          <Statistic
            title="全园当前负荷"
            value={data?.currentTotalKw ?? 0}
            precision={2}
            suffix="kW"
            valueStyle={{ fontSize: 18, color: '#0f766e' }}
          />
        </Col>
        <Col span={4}>
          <Statistic
            title="区间最高需量"
            value={data?.periodPeakKw ?? 0}
            precision={2}
            suffix="kW"
            valueStyle={{ fontSize: 18, color: '#d97706' }}
          />
        </Col>
      </Row>

      {curve.isLoading ? (
        <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#638072' }}>
          加载中…
        </div>
      ) : (
        <LoadCurveChart data={data ?? emptyCurve} />
      )}

      {mode === 'single' && data?.meterParams && (
        <div className="meter-params">
          <div className="meter-params-title">回路运行参数档案：{data.meterParams.roomDetailAddr}</div>
          <div className="meter-params-body">
            <span>• <b>电表编号</b>: {data.meterParams.meterNo}</span>
            <span>• <b>所属场景</b>: {data.meterParams.category}</span>
            <span>• <b>互感器倍率</b>: {Math.round(data.meterParams.multiplier)}x</span>
            <span>• <b>CT/PT规格</b>: {data.meterParams.ctRate}</span>
            <span>• <b>通信方式</b>: {data.meterParams.commType || '电信NB-IoT'}</span>
            <span>• <b>继电器状态</b>: <span style={{ color: '#059669', fontWeight: 700 }}>{data.meterParams.relayStatusDesc}</span></span>
            <span>• <b>单表当前负荷</b>: <b style={{ color: '#2563eb' }}>{data.meterParams.currentKw.toFixed(2)} kW</b></span>
            <span>• <b>区间最高需量</b>: <b style={{ color: '#d97706' }}>{data.meterParams.peakKw.toFixed(2)} kW</b></span>
            <span>• <b>区间平均负荷</b>: <b style={{ color: '#059669' }}>{data.meterParams.avgKw.toFixed(2)} kW</b></span>
            <span>• <b>折算总底数</b>: {data.meterParams.realKwh.toFixed(2)} kWh</span>
          </div>
        </div>
      )}
    </div>
  );
}
