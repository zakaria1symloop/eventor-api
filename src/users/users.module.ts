import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { AvatarsService } from './avatars.service.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { AdminUsersController } from './admin-users.controller.js';
import { UserFiltersDto, type UserRowDto } from './dto/users.dto.js';
import { UserAccountsService } from './user-accounts.service.js';
import { UsersMailListener } from './users-mail.listener.js';
import { UsersService } from './users.service.js';

/** Module 4: client and provider accounts (USR-01…USR-13). Admins live in AdminsModule. */
@Module({
  imports: [BookingsModule],
  controllers: [AdminUsersController],
  providers: [UsersService, UserAccountsService, UsersMailListener, AvatarsService],
  exports: [UsersService, UserAccountsService, AvatarsService],
})
export class UsersModule implements OnModuleInit {
  constructor(
    private readonly users: UsersService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<UserFiltersDto, UserRowDto>({
      resource: 'users',
      screens: 'USR-01',
      filters: UserFiltersDto,
      columns: [
        { key: 'fullName', header: 'Name', value: (u) => u.fullName },
        { key: 'role', header: 'Role', value: (u) => u.role },
        { key: 'email', header: 'Email', value: (u) => u.email },
        { key: 'phone', header: 'Phone', value: (u) => u.phone },
        { key: 'status', header: 'Status', value: (u) => u.status },
        { key: 'verificationStatus', header: 'Verification', value: (u) => u.verificationStatus },
        { key: 'wilaya', header: 'Wilaya', value: (u) => (u.wilaya ? `${u.wilaya.code} ${u.wilaya.name}` : null) },
        { key: 'businessName', header: 'Business name', value: (u) => u.businessName },
        { key: 'category', header: 'Category', value: (u) => u.category?.nameEn ?? null },
        { key: 'rating', header: 'Rating', value: (u) => u.rating },
        { key: 'ratingCount', header: 'Ratings', value: (u) => u.ratingCount },
        { key: 'bookingsCount', header: 'Bookings', value: (u) => u.bookingsCount },
        { key: 'servicesCount', header: 'Services', value: (u) => u.servicesCount },
        { key: 'lastActiveAt', header: 'Last active (UTC)', value: (u) => u.lastActiveAt },
        { key: 'createdAt', header: 'Joined (UTC)', value: (u) => u.createdAt },
      ],
      defaultColumns: ['fullName', 'role', 'email', 'phone', 'status', 'wilaya', 'bookingsCount', 'createdAt'],
      count: (filters) => this.users.tabbed(filters).getCount(),
      fetch: (filters, page) => this.users.fetchRows(filters, undefined, page),
    });
  }
}
