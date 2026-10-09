import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, MaxLength, ValidateIf } from 'class-validator';
import { InvitationKind, TournamentRole } from '../../../common/enums/index.js';
import { Trim } from '../../../common/validators.js';

/** Invitación: por enlace (sin correo) o a la cuenta de un correo. El rol queda fijo. */
export class CreateInvitationDto {
  @ApiProperty({ enum: InvitationKind })
  @IsEnum(InvitationKind)
  kind: InvitationKind;

  @ApiProperty({ enum: TournamentRole })
  @IsEnum(TournamentRole)
  role: TournamentRole;

  @ApiPropertyOptional({ description: 'Solo ACCOUNT. La respuesta es la misma exista o no una cuenta con ese correo.' })
  @ValidateIf((o: CreateInvitationDto) => o.kind === InvitationKind.ACCOUNT)
  @Trim()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class UpdateTournamentMemberDto {
  @ApiProperty({ enum: TournamentRole })
  @IsEnum(TournamentRole)
  role: TournamentRole;
}
