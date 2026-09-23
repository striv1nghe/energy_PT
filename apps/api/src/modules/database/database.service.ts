import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findWorkspaceRoot } from '../../common/paths';
import { INIT_SQL } from './schema';

export interface DbFingerprint {
  mtimeMs: number;
  size: number;
  dataVersion: number;
}

export interface DiskUsage {
  totalBytes: number;
  dbBytes: number;
  usagePercent: number;
  thresholdPercent: number;
  alarm: boolean;
}

/**
 * 基于 Node 内置 node:sqlite (DatabaseSync) 的同步访问封装。
 * 无原生依赖、无需编译，Node >= 22 开箱即用，后续可平滑替换为 PostgreSQL。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db: DatabaseSync | null = null;
  private changeCounter = 0;
  readonly dbPath: string;

  constructor() {
    this.dbPath = process.env.BBI_DB_PATH ?? join(findWorkspaceRoot(), 'data', 'energy_data.db');
  }

  onModuleInit(): void {
    if (!existsSync(this.dbPath)) {
      this.logger.warn(`数据库文件不存在，将新建: ${this.dbPath}`);
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec(INIT_SQL);
    this.logger.log(`SQLite 已连接: ${this.dbPath}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private get conn(): DatabaseSync {
    if (!this.db) throw new Error('DatabaseService 尚未初始化');
    return this.db;
  }

  /** 查询多行。params 使用命名参数对象（如 { meter_no: 'x' }），避免位置参数歧义。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryAll<T = Record<string, unknown>>(sql: string, params?: any): T[] {
    const stmt = this.conn.prepare(sql);
    return (params === undefined ? stmt.all() : stmt.all(params)) as T[];
  }

  /** 查询单行。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryOne<T = Record<string, unknown>>(sql: string, params?: any): T | undefined {
    const stmt = this.conn.prepare(sql);
    return (params === undefined ? stmt.get() : stmt.get(params)) as T | undefined;
  }

  /** 执行写入语句，返回变更行数与最后插入 id。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(sql: string, params?: any): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const stmt = this.conn.prepare(sql);
    const result = (params === undefined ? stmt.run() : stmt.run(params)) as never;
    this.changeCounter++;
    return result;
  }

  exec(sql: string): void {
    this.conn.exec(sql);
    this.changeCounter++;
  }

  /** 本连接内的写操作版本号：用于缓存失效（同连接写入时 data_version/mtime 不变化，需自行计数）。 */
  get changeVersion(): number {
    return this.changeCounter;
  }

  /** 数据库指纹：mtime + 文件大小 + PRAGMA data_version，用于缓存失效判断。 */
  fingerprint(): DbFingerprint {
    const stat = statSync(this.dbPath);
    const row = this.queryOne<{ data_version: number }>('PRAGMA data_version');
    return { mtimeMs: stat.mtimeMs, size: stat.size, dataVersion: row?.data_version ?? 0 };
  }

  /** 磁盘占用：数据库文件大小占所在磁盘总空间的比例，超过阈值即告警。 */
  getDiskUsage(): DiskUsage {
    const stat = statSync(this.dbPath);
    const fsStat = statfsSync(this.dbPath);
    const totalBytes = fsStat.blocks * fsStat.bsize;
    const dbBytes = stat.size;
    const usagePercent = totalBytes > 0 ? (dbBytes / totalBytes) * 100 : 0;
    const thresholdPercent = Number(process.env.DISK_ALARM_THRESHOLD_PERCENT || '50');
    return {
      totalBytes,
      dbBytes,
      usagePercent: Math.round(usagePercent * 100) / 100,
      thresholdPercent,
      alarm: usagePercent >= thresholdPercent,
    };
  }
}
