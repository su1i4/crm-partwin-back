import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Списки: ?page&limit&sort (ТЗ: ответ { items, total }). sort=field или -field */
export class PageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Поле сортировки; минус — по убыванию: -createdAt' })
  @IsOptional()
  @IsString()
  @Matches(/^-?[a-zA-Z][a-zA-Z0-9_]*$/)
  sort?: string;

  @ApiPropertyOptional({ description: 'Поиск по тексту' })
  @IsOptional()
  @IsString()
  q?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** Безопасная сортировка: только из белого списка полей. */
export function toOrder(
  sort: string | undefined,
  allowed: string[],
  fallback: Record<string, 'ASC' | 'DESC'>,
): Record<string, 'ASC' | 'DESC'> {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? 'DESC' : 'ASC' };
}

export const skipTake = (q: PageQueryDto) => ({ skip: (q.page - 1) * q.limit, take: q.limit });
