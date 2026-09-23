import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { SyncService } from './sync.service';

/** 三级同步定时调度器，替代原 Python daemon 的 while True 循环。 */
@Injectable()
export class SyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncScheduler.name);

  constructor(private readonly sync: SyncService) {}

  private get enabled(): boolean {
    return process.env.SYNC_DAEMON === 'true';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('同步调度器未启用（设置 SYNC_DAEMON=true 以启用）。');
      return;
    }
    this.logger.log('同步调度器已启用，执行启动首次三级对齐初始化...');
    try {
      // 回填最近 N 天 15 分钟采样，补齐停机期间的数据缺口
      const catchupDays = Number(process.env.BBI_CATCHUP_DAYS ?? 3);
      await this.sync.backfillIntraday('', String(catchupDays));
      await this.sync.runMode('all', {});
    } catch (e) {
      this.logger.error('启动首次同步失败: %s', (e as Error).message);
    }
  }

  /** 分钟级：告警轮询（60 秒） */
  @Interval(60_000)
  async handleAlarm() {
    if (!this.enabled) return;
    try {
      await this.sync.syncAlarm();
    } catch (e) {
      this.logger.error('告警轮询失败: %s', (e as Error).message);
    }
  }

  /** 15 分钟级：负荷采样（每刻钟）——先回填近期缺口，再采集实时工况。 */
  @Cron('0 */15 * * * *')
  async handleSample() {
    if (!this.enabled) return;
    try {
      // 补齐 getReadingDataInfo 数据延迟窗口内的 15 分钟网格缺口
      await this.sync.backfillRecentWindow('', 180);
      // 采集最新实时工况（getAllMetersV3，含继电器/在线状态）
      await this.sync.syncSample();
    } catch (e) {
      this.logger.error('负荷采样失败: %s', (e as Error).message);
    }
  }

  /** 天级：每日凌晨 02:00 日冻结同步 */
  @Cron('0 0 2 * * *')
  async handleDaily() {
    if (!this.enabled) return;
    try {
      await this.sync.runMode('daily', { days: 2 });
    } catch (e) {
      this.logger.error('日冻结同步失败: %s', (e as Error).message);
    }
  }
}
