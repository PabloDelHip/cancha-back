import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, type AuthResult } from './auth.service.js';
import { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { Public } from './decorators/public.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import {
  LEGACY_REFRESH_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  type AuthUser,
} from './auth.types.js';
import type { EnvConfig } from '../../config/env.validation.js';

/**
 * El refresh token viaja SOLO en una cookie HttpOnly (JS no puede leerla);
 * el access token va en el body y el frontend lo guarda en memoria.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.secureCookies =
      config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @Public()
  @SkipThrottle({ refresh: true })
  @Post('register')
  @ApiOperation({ summary: 'Crear cuenta e iniciar sesión' })
  @ApiConflictResponse({ description: 'Ya existe una cuenta con ese email' })
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      res,
      await this.auth.register(dto, { userAgent: req.get('user-agent') }),
    );
  }

  @Public()
  @SkipThrottle({ refresh: true })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión' })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      res,
      await this.auth.login(dto, { userAgent: req.get('user-agent') }),
    );
  }

  @Public()
  @SkipThrottle({ credentials: true })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'Renovar el access token (rota el refresh token de la cookie)',
  })
  @ApiUnauthorizedResponse({
    description: 'Sin cookie, token inválido, rotado o sesión revocada',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return this.respond(
        res,
        await this.auth.refresh(this.cookie(req), {
          userAgent: req.get('user-agent'),
        }),
      );
    } catch (error) {
      this.clearCookie(res);
      throw error;
    }
  }

  @Public()
  @SkipThrottle({ credentials: true, refresh: true })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'Cerrar sesión: revoca la sesión de la cookie y la elimina',
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(this.cookie(req));
    this.clearCookie(res);
  }

  @SkipThrottle({ credentials: true, refresh: true })
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cerrar sesión en todos los dispositivos' })
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(user.id);
    this.clearCookie(res);
  }

  @SkipThrottle({ credentials: true, refresh: true })
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Usuario autenticado' })
  @ApiUnauthorizedResponse({ description: 'Sin access token válido' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  private respond(res: Response, result: AuthResult) {
    // Nunca en caché (CDN de Firebase Hosting / proxies): lleva un token y una cookie nueva.
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(LEGACY_REFRESH_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.secureCookies, path: REFRESH_COOKIE_PATH });
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      path: REFRESH_COOKIE_PATH,
      expires: result.refreshExpiresAt,
    });
    return {
      user: result.user,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
  }

  private clearCookie(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    for (const name of [REFRESH_COOKIE, LEGACY_REFRESH_COOKIE]) {
      res.clearCookie(name, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.secureCookies,
        path: REFRESH_COOKIE_PATH,
      });
    }
  }

  private cookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE] ?? cookies?.[LEGACY_REFRESH_COOKIE];
    return typeof value === 'string' ? value : undefined;
  }
}
