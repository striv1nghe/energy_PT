import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.PLATFORM_JWT_SECRET || 'energy-platform-secret-change-me',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [PlatformAuthService],
})
export class PlatformAuthModule {}
