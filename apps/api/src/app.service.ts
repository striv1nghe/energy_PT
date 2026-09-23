import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      ok: true,
      service: 'energy-api',
      time: new Date().toISOString(),
    };
  }
}
