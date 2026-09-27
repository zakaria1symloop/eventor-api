import { ApiProperty } from '@nestjs/swagger';
import { AcademicRequestStatus } from '../../common/enums/academic.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

export class AppAcademicRequestsQueryDto extends PaginationQueryDto {}

/** A row of "My event requests": the requests this account submitted through the web form. */
export class AppAcademicRequestRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'ACR-000142' }) reference: string;
  @ApiProperty({ example: 'Graduation ceremony · Faculty of Medicine' }) title: string;
  @ApiProperty({ enum: AcademicRequestStatus, example: AcademicRequestStatus.Pending }) status: AcademicRequestStatus;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-06-30' }) eventDate: string | null;
  @ApiProperty({ format: 'date-time' }) submittedAt: string;
}

/** One answer, rendered with the request's own immutable form version. */
export class AppAcademicAnswerDto {
  @ApiProperty({ example: 'attendees' }) key: string;
  @ApiProperty({ example: 'number', description: 'The field type of the form version.' }) type: string;
  @ApiProperty({ example: 'Expected attendees' }) labelEn: string;
  @ApiProperty({ example: 'عدد الحضور المتوقع' }) labelAr: string;
  @ApiProperty({ type: String, nullable: true, example: 'General', description: 'The form section the field belongs to.' }) section: string | null;
  @ApiProperty({ nullable: true, description: 'The raw answer as submitted.' }) value: unknown;
  @ApiProperty({ type: String, nullable: true, example: '250', description: 'The answer rendered for display (choices resolved, wilaya and file names filled in).' })
  displayValue: string | null;
}

export class AppAcademicRequestDetailDto extends AppAcademicRequestRowDto {
  @ApiProperty({ type: [AppAcademicAnswerDto], description: 'Every answer, rendered with the form version the request was submitted with.' })
  answers: AppAcademicAnswerDto[];
}
