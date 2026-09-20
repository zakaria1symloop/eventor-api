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
