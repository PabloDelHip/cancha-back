import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model, Types } from 'mongoose';
import { User } from './schemas/user.schema.js';
import { UserRole } from '../../common/enums/index.js';

/** Representación segura de un usuario: nunca incluye passwordHash. */
export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/** Parámetros Argon2id (valores por defecto de la librería, recomendados por OWASP). */
const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  /** Hash fijo para igualar el tiempo de respuesta cuando el email no existe. */
  private dummyHash?: Promise<string>;

  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async create(input: CreateUserInput): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    if (await this.users.exists({ email }))
      throw new ConflictException('Ya existe una cuenta con ese email');
    const created = await this.users.create({
      email,
      passwordHash: await this.hashPassword(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
      role: UserRole.ORGANIZER,
    });
    return toPublicUser(created.toObject());
  }

  /**
   * Devuelve el usuario si email y password coinciden; null en cualquier otro caso.
   * Si el email no existe también se ejecuta una verificación Argon2 (contra un hash
   * ficticio) para no revelar por tiempo de respuesta qué emails están registrados.
   */
  async verifyCredentials(
    email: string,
    password: string,
  ): Promise<PublicUser | null> {
    const user = await this.users
      .findOne({ email: normalizeEmail(email) })
      .select('+passwordHash')
      .lean();
    if (!user) {
      this.dummyHash ??= this.hashPassword('timing-equalizer-password');
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      return null;
    }
    const ok = await argon2
      .verify(user.passwordHash, password)
      .catch(() => false);
    return ok ? toPublicUser(user) : null;
  }

  async findById(id: string | Types.ObjectId): Promise<PublicUser | null> {
    const user = await this.users.findById(id).lean();
    return user ? toPublicUser(user) : null;
  }
}

export function toPublicUser(user: User & { _id: Types.ObjectId }): PublicUser {
  return {
    id: user._id.toHexString(),
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    createdAt: user.createdAt,
  };
}
