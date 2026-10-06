import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AuthSession } from './schemas/auth-session.schema.js';
import { UsersService, type PublicUser } from '../users/users.service.js';
import {
  durationToSeconds,
  type EnvConfig,
} from '../../config/env.validation.js';
import type { AccessTokenPayload, RefreshTokenPayload } from './auth.types.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  /** Segundos de vida del access token. */
  expiresIn: number;
  /** Solo para el controller (cookie HttpOnly); nunca va en el body. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface SessionContext {
  userAgent?: string;
}

/** Margen en que el token anterior se considera una carrera entre pestañas y no un robo. */
const ROTATION_GRACE_MS = 30_000;

/** El refresh token es aleatorio y de alta entropía: SHA-256 basta (no hace falta Argon2). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvConfig, true>,
    @InjectModel(AuthSession.name)
    private readonly sessions: Model<AuthSession>,
  ) {
    this.accessTtl = durationToSeconds(
      config.get('JWT_ACCESS_EXPIRES_IN', { infer: true }),
    );
    this.refreshTtl = durationToSeconds(
      config.get('JWT_REFRESH_EXPIRES_IN', { infer: true }),
    );
  }

  async register(dto: RegisterDto, ctx: SessionContext): Promise<AuthResult> {
    const user = await this.users.create(dto);
    return this.startSession(user, ctx);
  }

  async login(dto: LoginDto, ctx: SessionContext): Promise<AuthResult> {
    const user = await this.users.verifyCredentials(dto.email, dto.password);
    // Mensaje genérico: no revela si falló el email o la contraseña.
    if (!user) throw new UnauthorizedException('Invalid credentials');
    return this.startSession(user, ctx);
  }

  /**
   * Rotación: valida el refresh token, comprueba la sesión y su hash, y emite un par
   * NUEVO (access + refresh). El refresh anterior deja de servir.
   */
  async refresh(
    refreshToken: string | undefined,
    ctx: SessionContext,
  ): Promise<AuthResult> {
    const payload = await this.verifyRefresh(refreshToken);
    const presentedHash = hashToken(refreshToken!);
    const session = await this.sessions.findById(payload.sid);

    if (
      !session ||
      session.userId.toHexString() !== payload.sub ||
      session.revokedAt ||
      session.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    if (session.refreshTokenHash !== presentedHash) {
      const recentlyRotated =
        session.previousTokenHash === presentedHash &&
        session.rotatedAt !== null &&
        Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;
      if (!recentlyRotated) {
        // Un token ya rotado reaparece fuera del margen: posible robo → se revoca la sesión.
        session.revokedAt = new Date();
        await session.save();
        this.logger.warn(
          `Reutilización de refresh token detectada; sesión ${session.id} revocada`,
        );
      }
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    const user = await this.users.findById(session.userId);
    if (!user) throw new UnauthorizedException('Sesión inválida o expirada');

    const next = await this.signRefresh(user.id, session.id);
    // Actualización condicional: si dos peticiones rotan a la vez, solo una gana.
    const rotated = await this.sessions.updateOne(
      { _id: session._id, refreshTokenHash: presentedHash, revokedAt: null },
      {
        refreshTokenHash: hashToken(next.token),
        previousTokenHash: presentedHash,
        rotatedAt: new Date(),
        expiresAt: next.expiresAt,
        userAgent: ctx.userAgent?.slice(0, 200) ?? session.userAgent,
      },
    );
    if (rotated.modifiedCount !== 1)
      throw new UnauthorizedException('Sesión inválida o expirada');

    return this.buildResult(user, next.token, next.expiresAt);
  }

  /** Revoca la sesión del refresh token (si es válido). Idempotente. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const payload = await this.verifyRefresh(refreshToken).catch(() => null);
    if (!payload) return;
    await this.sessions.updateOne(
      { _id: payload.sid, revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  /** Revoca todas las sesiones del usuario (todos los dispositivos). */
  async logoutAll(userId: string): Promise<void> {
    await this.sessions.updateMany(
      { userId: new Types.ObjectId(userId), revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('Autenticación requerida');
    return user;
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private async startSession(
    user: PublicUser,
    ctx: SessionContext,
  ): Promise<AuthResult> {
    const sessionId = new Types.ObjectId();
    const refresh = await this.signRefresh(user.id, sessionId.toHexString());
    await this.sessions.create({
      _id: sessionId,
      userId: new Types.ObjectId(user.id),
      refreshTokenHash: hashToken(refresh.token),
      expiresAt: refresh.expiresAt,
      userAgent: ctx.userAgent?.slice(0, 200) ?? null,
    });
    return this.buildResult(user, refresh.token, refresh.expiresAt);
  }

  private async buildResult(
    user: PublicUser,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<AuthResult> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.accessTtl,
      algorithm: 'HS256',
    });
    return {
      user,
      accessToken,
      expiresIn: this.accessTtl,
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async signRefresh(userId: string, sessionId: string) {
    const payload: RefreshTokenPayload = { sub: userId, sid: sessionId };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.refreshTtl,
      algorithm: 'HS256',
      jwtid: randomUUID(), // cada token es único aunque se emitan dos en el mismo segundo
    });
    return { token, expiresAt: new Date(Date.now() + this.refreshTtl * 1000) };
  }

  private async verifyRefresh(
    token: string | undefined,
  ): Promise<RefreshTokenPayload> {
    if (!token) throw new UnauthorizedException('Sesión inválida o expirada');
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        algorithms: ['HS256'],
      });
      if (
        !Types.ObjectId.isValid(payload.sid) ||
        !Types.ObjectId.isValid(payload.sub)
      )
        throw new Error('claims inválidos');
      return payload;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }
}
