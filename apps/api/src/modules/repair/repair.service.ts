import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** 日冻结数据修正：针对上游平台「日冻结返回 0 / 缺失」造成的数据缺口。 */
@Injectable()
export class RepairService {
  private readonly logger = new Logger(RepairService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * 修正 meter_readings 的日冻结缺口：
   *   1. 用 15 分钟负荷采样在 00:00:00 的底数，回填/覆盖对应日期的日冻结（更可靠）；
   *   2. 对剩余的 0 值午夜冻结做「前向填充」（last observation carried forward）。
   */
  repairFreezeGaps(): { upserted: number; filled: number } {
    // ① 采样 00:00 底数 -> 日冻结（存在则覆盖，缺失则插入）
    const upsert = this.db.run(`
      INSERT INTO meter_readings (meter_no, project_id, data_time, total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh, multiplier, real_kwh, created_at)
      SELECT meter_no, project_id, sample_time, total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh, multiplier, real_kwh, created_at
      FROM meter_load_samples
      WHERE sample_time LIKE '%00:00:00' AND real_kwh > 0
      ON CONFLICT(meter_no, data_time) DO UPDATE SET
        total_kwh = excluded.total_kwh,
        rate1_kwh = excluded.rate1_kwh,
        rate2_kwh = excluded.rate2_kwh,
        rate3_kwh = excluded.rate3_kwh,
        rate4_kwh = excluded.rate4_kwh,
        multiplier = excluded.multiplier,
        real_kwh = excluded.real_kwh
    `);
    const upserted = Number(upsert.changes);

    // ② 剩余 0 值午夜冻结 -> 前向填充
    let filled = 0;
    const meters = this.db.queryAll<{ meter_no: string }>('SELECT DISTINCT meter_no FROM meters');
    for (const { meter_no } of meters) {
      const rows = this.db.queryAll<{ id: number; real_kwh: number }>(
        "SELECT id, real_kwh FROM meter_readings WHERE meter_no = :meter_no AND data_time LIKE '%00:00:00' ORDER BY data_time",
        { meter_no },
      );
      let carry = 0;
      for (const row of rows) {
        if (row.real_kwh > 0) {
          carry = row.real_kwh;
        } else if (carry > 0) {
          this.db.run('UPDATE meter_readings SET real_kwh = :v, total_kwh = :v WHERE id = :id', {
            v: carry,
            id: row.id,
          });
          filled++;
        }
      }
    }

    this.logger.log(`日冻结修正完成：采样回填 ${upserted} 条，0 值前向填充 ${filled} 条。`);
    return { upserted, filled };
  }
}
