import { Body, Controller, Get, Post } from '@nestjs/common';
import { SyncService, type SyncMode } from './sync.service';

interface RunSyncBody {
  mode?: SyncMode;
  date?: string;
  days?: number;
  backfillIntraday?: string;
}

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  status() {
    return this.sync.getStatus();
  }

  @Post('run')
  run(@Body() body: RunSyncBody) {
    return this.sync.runMode(body.mode ?? 'all', {
      date: body.date,
      days: body.days,
      backfillIntraday: body.backfillIntraday,
    });
  }
}
