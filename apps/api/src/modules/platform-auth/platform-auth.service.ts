import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/** 平台登录鉴权：校验用户名/密码并签发 JWT。 */
@Injectable()
export class PlatformAuthService {
  constructor(private readonly jwt: JwtService) {}

  validate(username: string, password: string): boolean {
    const u = process.env.PLATFORM_USERNAME || 'admin';
    const p = process.env.PLATFORM_PASSWORD || 'admin123';
    return username === u && password === p;
  }

  login(username: string): { accessToken: string } {
    return { accessToken: this.jwt.sign({ sub: username, username }) };
  }
}
