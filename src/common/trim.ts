import { Transform } from 'class-transformer';

// 스키마가 trim하는 필드는 DTO에서 먼저 trim해야 MinLength가 공백뿐인 값을 400으로 막는다.
// 안 하면 DTO는 통과하고 스키마 required에서 실패해 500이 난다.
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
