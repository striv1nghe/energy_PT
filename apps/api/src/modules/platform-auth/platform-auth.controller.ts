import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from './public.decorator';
import { PlatformAuthService } from './platform-auth.service';

@Controller('auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    if (!this.auth.validate(body.username ?? '', body.password ?? '')) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    return this.auth.login(body.username!);
  }
}
