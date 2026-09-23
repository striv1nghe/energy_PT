import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as https from 'node:https';
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
} from '@energy/shared';
import { DatabaseService } from '../database/database.service';
import { AuthService } from '../auth/auth.service';
import { classifyMeter } from '../../common/classify';

const BASE = 'https://a.bbicloud.com';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export type SyncMode = 'daily' | 'sample' | 'alarm' | 'all';

export interface SyncStatus {
  lastRunAt: string | null;
  daemonEnabled: boolean;
  lastResult: Record<string, number>;
}

function nowStr(): string {
  return new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
}

function toNum(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 三级同步服务：日冻结 / 15分钟负荷采样 / 分钟级告警，移植自 sync_energy_to_sqlite.py。 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private lastRunAt: string | null = null;
  private lastResult: Record<string, number> = {};

  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  getStatus(): SyncStatus {
    return {
      lastRunAt: this.lastRunAt,
      daemonEnabled: process.env.SYNC_DAEMON === 'true',
      lastResult: this.lastResult,
    };
  }

  projectId(): string {
    return process.env.BBI_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  }

  projectName(): string {
    return process.env.BBI_PROJECT_NAME ?? DEFAULT_PROJECT_NAME;
  }

  /** 统一请求：sid 失效时自动重登重试一次（对应原 make_request 的两次尝试）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async makeRequest(url: string, sid: string, attempt = 0): Promise<{ data: any; sid: string }> {
    const creds = this.auth.credentials();
    try {
      const resp = await axios.get(url, {
        httpsAgent,
        timeout: 10_000,
        headers: {
          Cookie: `sid=${sid}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          Referer: `${BASE}/v2/`,
          Accept: 'application/json, text/plain, */*',
        },
      });
      const data = resp.data;
      if (data?.code === 401 || String(data?.msg ?? '').includes('失效')) {
        if (attempt === 0 && creds.username && creds.password) {
          this.logger.warn('会话 SID 已失效，正在自动重登...');
          const newSid = await this.auth.login(creds.username, creds.password);
          if (newSid) return this.makeRequest(url, newSid, 1);
        }
        return { data, sid };
      }
      return { data, sid };
    } catch (e) {
      const err = e as { response?: { status?: number }; message?: string };
      const status = err.response?.status;
      if ((status === 401 || status === 403) && attempt === 0 && creds.username && creds.password) {
        this.logger.warn('会话 SID 已失效 (HTTP %d)，正在自动重登...', status);
        const newSid = await this.auth.login(creds.username, creds.password);
        if (newSid) return this.makeRequest(url, newSid, 1);
      }
      this.logger.error('网络请求异常: %s', err.message);
      return { data: null, sid };
    }
  }

  // -------------------------------------------------------------------------
  // Tier-1 日冻结
  // -------------------------------------------------------------------------
  async syncDaily(sid = '', targetDates: string[] = []): Promise<{ saved: number; sid: string }> {
    sid = sid || this.auth.getSid();
    const projectId = this.projectId();
    const projectName = this.projectName();
    let totalSaved = 0;
    const now = nowStr();

    for (const targetDate of targetDates) {
      const params = new URLSearchParams({
        bar_project_id: projectId,
        date: targetDate,
        bar_measure_type: '00080001',
        pageNumber: '1',
        pageSize: '50',
      });
      const url = `${BASE}/platform/bar/engineer/getReadingDataInfo/V2?${params.toString()}`;
      const { data: resp, sid: newSid } = await this.makeRequest(url, sid);
      sid = newSid;
      if (!resp || resp.code !== 0) {
        this.logger.warn('[Tier-1 日冻结] 日期 %s 拉取失败或无数据。', targetDate);
        continue;
      }
      const readings = resp.data?.datas ?? [];
      if (!readings.length) continue;

      this.db.run(
        `INSERT INTO projects (project_id, project_name, meter_count, updated_at)
         VALUES (:project_id, :project_name, :meter_count, :updated_at)
         ON CONFLICT(project_id) DO UPDATE SET
           project_name = excluded.project_name,
           meter_count = excluded.meter_count,
           updated_at = excluded.updated_at`,
        { project_id: projectId, project_name: projectName, meter_count: readings.length, updated_at: now },
      );

      for (const item of readings) {
        const meterNo = String(item.meter_no ?? '').trim();
        if (!meterNo) continue;
        const cons = item.mbr_cons_info ?? {};
        const roomAddr = String(cons.room_detail_addr ?? '');
        const category = classifyMeter(roomAddr);
        const rateVal = toNum(cons.rate, 1) || 1;
        const ctRate = String(cons.ct_rate ?? '');
        const ptRate = String(cons.pt_rate ?? '');
        const gatewayNo = String(item.gateway_no ?? cons.bar_gateway_no ?? '');
        const meterType = String(item.meter_type ?? '00080001');

        this.db.run(
          `INSERT INTO meters (meter_no, project_id, room_detail_addr, category, rate, ct_rate, pt_rate, gateway_no, meter_type, updated_at)
           VALUES (:meter_no, :project_id, :room_detail_addr, :category, :rate, :ct_rate, :pt_rate, :gateway_no, :meter_type, :updated_at)
           ON CONFLICT(meter_no) DO UPDATE SET
             room_detail_addr = excluded.room_detail_addr,
             category = excluded.category,
             rate = excluded.rate,
             ct_rate = excluded.ct_rate,
             pt_rate = excluded.pt_rate,
             gateway_no = excluded.gateway_no,
             updated_at = excluded.updated_at`,
          { meter_no: meterNo, project_id: projectId, room_detail_addr: roomAddr, category, rate: rateVal, ct_rate: ctRate, pt_rate: ptRate, gateway_no: gatewayNo, meter_type: meterType, updated_at: now },
        );

        const totalKwh = toNum(item.zxygzdl);
        const rate1 = toNum(item.zxygzdl1);
        const rate2 = toNum(item.zxygzdl2);
        const rate3 = toNum(item.zxygzdl3);
        const rate4 = toNum(item.zxygzdl4);
        const dataTime = String(item.sjsj ?? targetDate).trim();
        const realKwh = Math.round(totalKwh * rateVal * 100) / 100;

        this.db.run(
          `INSERT INTO meter_readings (meter_no, project_id, data_time, total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh, multiplier, real_kwh, created_at)
           VALUES (:meter_no, :project_id, :data_time, :total_kwh, :rate1_kwh, :rate2_kwh, :rate3_kwh, :rate4_kwh, :multiplier, :real_kwh, :created_at)
           ON CONFLICT(meter_no, data_time) DO UPDATE SET
             total_kwh = excluded.total_kwh,
             rate1_kwh = excluded.rate1_kwh,
             rate2_kwh = excluded.rate2_kwh,
             rate3_kwh = excluded.rate3_kwh,
             rate4_kwh = excluded.rate4_kwh,
             multiplier = excluded.multiplier,
             real_kwh = excluded.real_kwh,
             created_at = excluded.created_at`,
          { meter_no: meterNo, project_id: projectId, data_time: dataTime, total_kwh: totalKwh, rate1_kwh: rate1, rate2_kwh: rate2, rate3_kwh: rate3, rate4_kwh: rate4, multiplier: rateVal, real_kwh: realKwh, created_at: now },
        );
        totalSaved++;
      }
      this.logger.log('[Tier-1 日冻结] 日期 %s 成功入库 %d 条记录。', targetDate, readings.length);
    }
    return { saved: totalSaved, sid };
  }

  // -------------------------------------------------------------------------
  // Tier-2 15分钟负荷采样
  // -------------------------------------------------------------------------
  async syncSample(sid = ''): Promise<{ saved: number; sid: string }> {
    sid = sid || this.auth.getSid();
    const projectId = this.projectId();
    const now = nowStr();
    const params = new URLSearchParams({
      bar_project_id: projectId,
      bar_measure_type: '00080001',
      pageNumber: '1',
      pageSize: '50',
    });
    const url = `${BASE}/platform/bar/engineer/getAllMetersV3?${params.toString()}`;
    const { data: resp, sid: newSid } = await this.makeRequest(url, sid);
    sid = newSid;
    if (!resp || resp.code !== 0) {
      this.logger.warn('[Tier-2 负荷采样] 拉取实时设备工况失败。');
      return { saved: 0, sid };
    }
    const meterList = resp.data?.data ?? [];
    if (!meterList.length) return { saved: 0, sid };

    let saved = 0;
    for (const item of meterList) {
      const meterNo = String(item.bar_measure_no ?? '').trim();
      if (!meterNo) continue;
      const sampleTime = String(item.last_online_time ?? now).trim();
      const roomAddr = String(item.room_detail_addr ?? '');
      const category = classifyMeter(roomAddr);
      const rateVal = toNum(item.rate, 1) || 1;
      const totalKwh = toNum(item.zxygzdl);
      const rate1 = toNum(item.zxygzdl1);
      const rate2 = toNum(item.zxygzdl2);
      const rate3 = toNum(item.zxygzdl3);
      const rate4 = toNum(item.zxygzdl4);
      const realKwh = Math.round(totalKwh * rateVal * 100) / 100;
      const relayStatus = String(item.bar_measure_jdqzt ?? '');
      const onlineStatus = String(item.onlinestutus ?? '');
      const commType = String(item.comm_type_desc ?? '');
      const imeiNo = String(item.imei_no ?? '');
      const simNo = String(item.sim_no ?? '');
      const gatewayNo = String(item.bar_gateway_no ?? '');

      this.db.run(
        `INSERT INTO meter_load_samples (meter_no, project_id, sample_time, total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh, multiplier, real_kwh, relay_status, online_status, created_at)
         VALUES (:meter_no, :project_id, :sample_time, :total_kwh, :rate1_kwh, :rate2_kwh, :rate3_kwh, :rate4_kwh, :multiplier, :real_kwh, :relay_status, :online_status, :created_at)
         ON CONFLICT(meter_no, sample_time) DO UPDATE SET
           total_kwh = excluded.total_kwh,
           rate1_kwh = excluded.rate1_kwh,
           rate2_kwh = excluded.rate2_kwh,
           rate3_kwh = excluded.rate3_kwh,
           rate4_kwh = excluded.rate4_kwh,
           multiplier = excluded.multiplier,
           real_kwh = excluded.real_kwh,
           relay_status = excluded.relay_status,
           online_status = excluded.online_status,
           created_at = excluded.created_at`,
        { meter_no: meterNo, project_id: projectId, sample_time: sampleTime, total_kwh: totalKwh, rate1_kwh: rate1, rate2_kwh: rate2, rate3_kwh: rate3, rate4_kwh: rate4, multiplier: rateVal, real_kwh: realKwh, relay_status: relayStatus, online_status: onlineStatus, created_at: now },
      );

      this.db.run(
        `INSERT INTO meters (meter_no, project_id, room_detail_addr, category, rate, comm_type, imei_no, sim_no, gateway_no, updated_at)
         VALUES (:meter_no, :project_id, :room_detail_addr, :category, :rate, :comm_type, :imei_no, :sim_no, :gateway_no, :updated_at)
         ON CONFLICT(meter_no) DO UPDATE SET
           room_detail_addr = excluded.room_detail_addr,
           category = excluded.category,
           rate = excluded.rate,
           comm_type = excluded.comm_type,
           imei_no = excluded.imei_no,
           sim_no = excluded.sim_no,
           gateway_no = excluded.gateway_no,
           updated_at = excluded.updated_at`,
        { meter_no: meterNo, project_id: projectId, room_detail_addr: roomAddr, category, rate: rateVal, comm_type: commType, imei_no: imeiNo, sim_no: simNo, gateway_no: gatewayNo, updated_at: now },
      );
      saved++;
    }
    this.logger.log('[Tier-2 负荷采样] 成功入库 %d 条采样记录。', saved);
    return { saved, sid };
  }

  // -------------------------------------------------------------------------
  // Tier-3 分钟级告警
  // -------------------------------------------------------------------------
  async syncAlarm(sid = '', windowDays = 3): Promise<{ saved: number; sid: string }> {
    sid = sid || this.auth.getSid();
    const projectId = this.projectId();
    const now = new Date();
    const startTime = new Date(now.getTime() - windowDays * 86_400_000).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ').slice(0, 10) + ' 00:00:00';
    const endTime = new Date(now.getTime() + 3_600_000).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
    const params = new URLSearchParams({
      bar_project_id: projectId,
      start_time: startTime,
      end_time: endTime,
      pageNumber: '1',
      pageSize: '50',
    });
    const url = `${BASE}/platform/stat/meterAlarm/queryAlarmInfo?${params.toString()}`;
    const { data: resp, sid: newSid } = await this.makeRequest(url, sid);
    sid = newSid;
    if (!resp || resp.code !== 0) {
      this.logger.warn('[Tier-3 告警扫描] 查询告警事件失败。');
      return { saved: 0, sid };
    }
    const alarmList = resp.data?.list ?? [];
    if (!alarmList.length) return { saved: 0, sid };

    const nowStrVal = nowStr();
    for (const item of alarmList) {
      const meterNo = String(item.bar_measure_no ?? item.meter_no ?? '').trim();
      const alarmTime = String(item.alarm_time ?? item.sjsj ?? nowStrVal).trim();
      const alarmName = String(item.alarm_name ?? item.event_name ?? '未命名告警').trim();
      const alarmCode = String(item.alarm_code ?? item.code ?? '');
      const roomAddr = String(item.room_detail_addr ?? '');
      const alarmStatus = String(item.status_desc ?? item.status ?? '告警中');
      const rawJson = JSON.stringify(item);

      this.db.run(
        `INSERT INTO alarm_events (meter_no, project_id, alarm_time, alarm_name, alarm_code, room_addr, alarm_status, raw_data, created_at)
         VALUES (:meter_no, :project_id, :alarm_time, :alarm_name, :alarm_code, :room_addr, :alarm_status, :raw_data, :created_at)
         ON CONFLICT(meter_no, alarm_time, alarm_name) DO UPDATE SET
           alarm_status = excluded.alarm_status,
           created_at = excluded.created_at`,
        { meter_no: meterNo, project_id: projectId, alarm_time: alarmTime, alarm_name: alarmName, alarm_code: alarmCode, room_addr: roomAddr, alarm_status: alarmStatus, raw_data: rawJson, created_at: nowStrVal },
      );
    }
    this.logger.log('[Tier-3 告警扫描] 本次共记录/更新 %d 条告警事件。', alarmList.length);
    return { saved: alarmList.length, sid };
  }

  // -------------------------------------------------------------------------
  // 历史 15 分钟负荷回填
  // -------------------------------------------------------------------------
  async backfillIntraday(sid = '', targetSpec: string): Promise<{ saved: number; sid: string }> {
    sid = sid || this.auth.getSid();
    const projectId = this.projectId();
    const spec = String(targetSpec ?? '').trim().toLowerCase();
    const now = new Date();
    const dates: string[] = [];
    if (/^\d+$/.test(spec)) {
      const n = parseInt(spec, 10);
      for (let i = 0; i < n; i++) dates.push(this.dateStr(new Date(now.getTime() - i * 86_400_000)));
    } else if (['today', '当前', '今天', ''].includes(spec)) {
      dates.push(this.dateStr(now));
    } else {
      dates.push(String(targetSpec).trim());
    }

    let totalSaved = 0;
    for (const dateStr of dates) {
      const points: string[] = [];
      const start = new Date(`${dateStr} 00:00:00`);
      const end = dateStr === this.dateStr(now) ? now : new Date(`${dateStr} 23:45:00`);
      for (let t = start.getTime(); t <= end.getTime(); t += 900_000) {
        points.push(this.dateTimeStr(new Date(t)));
      }
      totalSaved += await this.fetchAndStoreSamples(sid, projectId, points);
      this.logger.log('[历史回填] 日期 %s 成功写入负荷样本。', dateStr);
    }
    this.logger.log('[历史回填] 全部完成！共 %d 条。', totalSaved);
    return { saved: totalSaved, sid };
  }

  /**
   * 回填最近若干分钟内的 15 分钟采样（按 15 分钟网格对齐）。
   * 用于定期补齐 getReadingDataInfo 数据延迟窗口内的缺口，保证负荷曲线连续、无缺步。
   */
  async backfillRecentWindow(sid = '', minutes = 180): Promise<{ saved: number; sid: string }> {
    sid = sid || this.auth.getSid();
    const projectId = this.projectId();
    const nowMs = Date.now();
    const startMs = Math.ceil((nowMs - minutes * 60_000) / 900_000) * 900_000;
    const points: string[] = [];
    for (let t = startMs; t <= nowMs; t += 900_000) {
      points.push(this.dateTimeStr(new Date(t)));
    }
    const saved = await this.fetchAndStoreSamples(sid, projectId, points);
    this.logger.log('[近期回填] 最近 %d 分钟内补齐 %d 条负荷样本。', minutes, saved);
    return { saved, sid };
  }

  /** 抓取给定 15 分钟时间点的读数并写入 meter_load_samples。 */
  private async fetchAndStoreSamples(sid: string, projectId: string, points: string[]): Promise<number> {
    if (points.length === 0) return 0;
    const rows = await this.fetchSlicesConcurrent(sid, projectId, points);
    const nowStrVal = nowStr();
    let saved = 0;
    for (const { dtStr, datas } of rows) {
      for (const item of datas ?? []) {
        const meterNo = String(item.meter_no ?? '').trim();
        if (!meterNo) continue;
        const rawTotal = item.zxygzdl;
        if (rawTotal === null || rawTotal === undefined || ['', 'None'].includes(String(rawTotal).trim())) continue;
        const totalKwh = toNum(rawTotal);
        if (totalKwh <= 0) continue;
        const cons = item.mbr_cons_info ?? {};
        const rateVal = toNum(cons.rate, 1) || 1;
        const realKwh = Math.round(totalKwh * rateVal * 100) / 100;

        this.db.run(
          `INSERT INTO meter_load_samples (meter_no, project_id, sample_time, total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh, multiplier, real_kwh, relay_status, online_status, created_at)
           VALUES (:meter_no, :project_id, :sample_time, :total_kwh, :rate1_kwh, :rate2_kwh, :rate3_kwh, :rate4_kwh, :multiplier, :real_kwh, :relay_status, :online_status, :created_at)
           ON CONFLICT(meter_no, sample_time) DO UPDATE SET
             total_kwh = excluded.total_kwh,
             rate1_kwh = excluded.rate1_kwh,
             rate2_kwh = excluded.rate2_kwh,
             rate3_kwh = excluded.rate3_kwh,
             rate4_kwh = excluded.rate4_kwh,
             multiplier = excluded.multiplier,
             real_kwh = excluded.real_kwh,
             relay_status = excluded.relay_status,
             online_status = excluded.online_status,
             created_at = excluded.created_at`,
          { meter_no: meterNo, project_id: projectId, sample_time: dtStr, total_kwh: totalKwh, rate1_kwh: toNum(item.zxygzdl1), rate2_kwh: toNum(item.zxygzdl2), rate3_kwh: toNum(item.zxygzdl3), rate4_kwh: toNum(item.zxygzdl4), multiplier: rateVal, real_kwh: realKwh, relay_status: '合闸', online_status: '在线', created_at: nowStrVal },
        );
        saved++;
      }
    }
    return saved;
  }

  private async fetchSlicesConcurrent(sid: string, projectId: string, points: string[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: Array<{ dtStr: string; datas: any[] }> = [];
    const CONCURRENCY = 8;
    for (let i = 0; i < points.length; i += CONCURRENCY) {
      const batch = points.slice(i, i + CONCURRENCY);
      const part = await Promise.all(
        batch.map(async (dtStr) => {
          const params = new URLSearchParams({ bar_project_id: projectId, date: dtStr, bar_measure_type: '00080001', pageNumber: '1', pageSize: '50' });
          const url = `${BASE}/platform/bar/engineer/getReadingDataInfo/V2?${params.toString()}`;
          const { data: resp } = await this.makeRequest(url, sid);
          if (resp && resp.code === 0) return { dtStr, datas: resp.data?.datas ?? [] };
          return { dtStr, datas: [] };
        }),
      );
      results.push(...part);
    }
    return results;
  }

  private dateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  private dateTimeStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`;
  }

  // -------------------------------------------------------------------------
  // 汇总执行
  // -------------------------------------------------------------------------
  async runMode(mode: SyncMode, opts: { date?: string; days?: number; backfillIntraday?: string }): Promise<SyncStatus> {
    let sid = this.auth.getSid();
    const counts: Record<string, number> = {};
    const now = new Date();

    const targetDates: string[] = [];
    if (mode === 'daily' || mode === 'all') {
      if (opts.date) targetDates.push(`${opts.date} 00:00:00`);
      else {
        const days = opts.days ?? 1;
        for (let i = 0; i < days; i++) targetDates.push(`${this.dateStr(new Date(now.getTime() - i * 86_400_000))} 00:00:00`);
      }
      const r = await this.syncDaily(sid, targetDates);
      sid = r.sid;
      counts.daily = r.saved;
    }
    if (mode === 'sample' || mode === 'all') {
      // 先补齐近期 15 分钟网格缺口，再采集实时工况（对齐调度器 handleSample）
      const b = await this.backfillRecentWindow(sid);
      sid = b.sid;
      counts.backfillRecent = b.saved;
      const r = await this.syncSample(sid);
      sid = r.sid;
      counts.sample = r.saved;
    }
    if (opts.backfillIntraday) {
      const r = await this.backfillIntraday(sid, opts.backfillIntraday);
      sid = r.sid;
      counts.backfill = r.saved;
    }
    if (mode === 'alarm' || mode === 'all') {
      const r = await this.syncAlarm(sid);
      sid = r.sid;
      counts.alarm = r.saved;
    }

    this.lastRunAt = nowStr();
    this.lastResult = counts;
    return this.getStatus();
  }
}
