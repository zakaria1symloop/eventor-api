import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Query parameters every list endpoint accepts (docs/api-decisions.md,
 * decision 1). Endpoint query DTOs extend this and add their own filters.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit = DEFAULT_PAGE_SIZE;

  @ApiPropertyOptional({
    example: 'createdAt:desc',
    description:
      '`field:asc` or `field:desc`. Each endpoint lists the fields it can sort by.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9]*:(asc|desc)$/, {
    message: 'sort must look like field:asc or field:desc',
  })
  sort?: string;
}
