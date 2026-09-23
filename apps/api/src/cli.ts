import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SyncService, type SyncMode } from './modules/sync/sync.service';
import { RepairService } from './modules/repair/repair.service';

/**
 * 单次同步 / 维护 CLI：
 *   node dist/cli.js [daily|sample|alarm|all]
 *   node dist/cli.js backfill [today|YYYY-MM-DD|N天]
 *   node dist/cli.js repair
 */
async function main() {
  const mode = process.argv[2] ?? 'all';
  const arg = process.argv[3] ?? '';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  if (mode === 'backfill') {
    const sync = app.get(SyncService);
    const r = await sync.backfillIntraday('', arg || 'today');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r));
  } else if (mode === 'repair') {
    const repair = app.get(RepairService);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(repair.repairFreezeGaps()));
  } else {
    const sync = app.get(SyncService);
    const status = await sync.runMode(mode as SyncMode, {});
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(status));
  }
  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
