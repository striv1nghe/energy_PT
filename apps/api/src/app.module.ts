import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './modules/database/database.module';
import { EnergyModule } from './modules/energy/energy.module';
import { AuthModule } from './modules/auth/auth.module';
import { SyncModule } from './modules/sync/sync.module';
import { RepairModule } from './modules/repair/repair.module';
import { PlatformAuthModule } from './modules/platform-auth/platform-auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    EnergyModule,
    SyncModule,
    RepairModule,
    PlatformAuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
