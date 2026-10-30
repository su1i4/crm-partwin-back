import { HttpStatus, ValidationError } from '@nestjs/common';
import { AppException } from '../errors/app.exception';

function flatten(errors: ValidationError[], prefix = ''): { field: string; errors: string[] }[] {
  const out: { field: string; errors: string[] }[] = [];
  for (const e of errors) {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) out.push({ field, errors: Object.values(e.constraints) });
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}

export const validationExceptionFactory = (errors: ValidationError[]) =>
  new AppException('VALIDATION_ERROR', 'Проверьте заполнение полей', HttpStatus.BAD_REQUEST, flatten(errors));
