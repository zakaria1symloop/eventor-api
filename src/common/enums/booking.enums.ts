export enum BookingStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Completed = 'completed',
}

export enum BookingDisputeStatus {
  None = 'none',
  Open = 'open',
  Resolved = 'resolved',
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

/**
 * Who cancelled a booking (BUG-H4 / M3): the client or the provider from the
 * app, an admin (dashboard, block, dispute outcome), or the system (no person:
 * a job or an emailed link). Only `client` and `provider` mean that party.
 */
export enum CancelledBy {
  Client = 'client',
  Provider = 'provider',
  Admin = 'admin',
  System = 'system',
}
