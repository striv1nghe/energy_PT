import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { LoadCurveMode } from '@energy/shared';
import { EnergyService } from './energy.service';
import { toCsv, type CsvColumn } from './csv';

function csvFilename(zh: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `attachment; filename="energy_${stamp}.csv"; filename*=UTF-8''${encodeURIComponent(zh)}`;
}

@Controller()
export class EnergyController {
  constructor(private readonly energy: EnergyService) {}

  @Get('overview')
  overview() {
    return this.energy.getOverview();
  }

  @Get('kpi')
  kpi(@Query('start') start?: string, @Query('end') end?: string) {
    return this.energy.getKpi(start, end);
  }

  @Get('daily-usage')
  dailyUsage(@Query('start') start?: string, @Query('end') end?: string) {
    return this.energy.getDailyUsage(start, end);
  }

  @Get('load-curve')
  loadCurve(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('mode') mode?: string,
    @Query('meters') meters?: string,
    @Query('category') category?: string,
  ) {
    const meterNos = (meters ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.energy.getLoadCurve(start, end, (mode as LoadCurveMode) ?? 'total', meterNos, category);
  }

  @Get('meters')
  meters(@Query('category') category?: string, @Query('search') search?: string) {
    return this.energy.getMeters(category, search);
  }

  @Get('alarms')
  alarms() {
    return this.energy.getAlarms();
  }

  @Get('export/daily.csv')
  exportDaily(@Res() res: Response, @Query('start') start?: string, @Query('end') end?: string) {
    const { usageDaily } = this.energy.getDailyUsage(start, end);
    const cols: CsvColumn[] = [
      { key: 'date', label: '日期' },
      { key: 'usage', label: '用电量(kWh)' },
    ];
    const rows = usageDaily.map((d) => ({ date: d.date, usage: d.usage_kwh }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvFilename('园区每日用电报表.csv'));
    res.send(toCsv(rows, cols));
  }

  @Get('export/category.csv')
  exportCategory(@Res() res: Response, @Query('start') start?: string, @Query('end') end?: string) {
    const { categoryDaily } = this.energy.getDailyUsage(start, end);
    const cols: CsvColumn[] = [
      { key: 'date', label: '日期' },
      { key: 'category', label: '分类' },
      { key: 'usage', label: '用电量(kWh)' },
    ];
    const rows = categoryDaily.map((d) => ({ date: d.date, category: d.category, usage: d.usage_kwh }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvFilename('园区场景分类用电报表.csv'));
    res.send(toCsv(rows, cols));
  }

  @Get('export/ledger.csv')
  exportLedger(@Res() res: Response) {
    const { rows } = this.energy.getMeters();
    const cols: CsvColumn[] = [
      { key: 'meterNo', label: '电表编号' },
      { key: 'roomDetailAddr', label: '安装点位' },
      { key: 'category', label: '用电分类' },
      { key: 'realKwh', label: '折算真实底数(kWh)' },
      { key: 'powerKw', label: '实时功率(kW)' },
      { key: 'relayStatusDesc', label: '继电器状态' },
      { key: 'onlineStatusDesc', label: '在线状态' },
      { key: 'sampleTime', label: '最新采样时间' },
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvFilename('电表实时台账.csv'));
    res.send(toCsv(rows as unknown as Array<Record<string, unknown>>, cols));
  }
}
