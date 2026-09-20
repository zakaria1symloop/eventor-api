export enum BookingStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Completed = 'completed',
}

export enum CancelledBy {
  Client = 'client',
  Provider = 'provider',
  Admin = 'admin',
}

export enum BookingSource {
  Android = 'android',
  Ios = 'ios',
  Web = 'web',
  Dashboard = 'dashboard',
}

export enum BookingLineKind {
  Service = 'service',
  Extra = 'extra',
  PackService = 'pack_service',
  Discount = 'discount',
  Adjustment = 'adjustment',
}

export enum RescheduleStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}

export enum AcademicRequestStatus {
  Draft = 'draft',
  Pending = 'pending',
  ChangesRequested = 'changes_requested',
  Approved = 'approved',
  Rejected = 'rejected',
  Completed = 'completed',
  Cancelled = 'cancelled',
}
