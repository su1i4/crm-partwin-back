import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'Бакыт', description: 'Имя владельца' })
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiProperty({ example: '0555123456', description: 'Телефон или email' })
  @IsString()
  @Length(3, 200)
  login: string;

  @ApiProperty({ example: 'secret123', minLength: 6 })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  @ApiProperty({ example: 'Автозапчасти на Дордое' })
  @IsString()
  @Length(1, 200)
  shopName: string;

  @ApiPropertyOptional({ enum: ['ru', 'ky'], default: 'ru' })
  @IsOptional()
  @IsIn(['ru', 'ky'])
  locale?: string;
}

export class LoginDto {
  @ApiProperty({ example: '0555123456', description: 'Телефон или email' })
  @IsString()
  @Length(3, 200)
  login: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  @MaxLength(100)
  password: string;

  @ApiPropertyOptional({ description: 'Код из приложения-аутентификатора, если включена 2FA' })
  @IsOptional()
  @Matches(/^\d{6}$/)
  totpCode?: string;
}

export class SelectTenantDto {
  @ApiProperty()
  @IsUUID()
  tenantId: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Refresh-токен. Обычно берётся из httpOnly cookie, поле — для Swagger и тестов' })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  oldPassword: string;

  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  newPassword: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({ enum: ['ru', 'ky'] })
  @IsOptional()
  @IsIn(['ru', 'ky'])
  locale?: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/)
  code: string;
}

export class TotpDisableDto extends TotpCodeDto {
  @ApiProperty()
  @IsString()
  password: string;
}

export class AcceptInviteDto {
  @ApiProperty({ example: 'K7M2P9QX', description: 'Код приглашения' })
  @IsString()
  @Length(6, 64)
  code: string;

  @ApiProperty({ example: '0555123456', description: 'Телефон или email' })
  @IsString()
  @Length(3, 200)
  login: string;

  @ApiProperty({ description: 'Пароль: существующий (если учётная запись уже есть) или новый' })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  @ApiPropertyOptional({ description: 'Имя — нужно, если учётной записи ещё нет' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{6}$/)
  totpCode?: string;
}
