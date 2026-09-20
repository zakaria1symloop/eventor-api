export enum UserRole {
  Client = 'client',
  Provider = 'provider',
  Admin = 'admin',
}

export enum UserStatus {
  Active = 'active',
  Blocked = 'blocked',
}

/** Providers only; clients and admins are `not_required`. */
export enum VerificationStatus {
  NotRequired = 'not_required',
  Pending = 'pending',
  Verified = 'verified',
  Rejected = 'rejected',
}

export enum Language {
  Ar = 'ar',
  En = 'en',
}

/** Who acted on a booking or opened a dispute. */
export enum PartyRole {
  Client = 'client',
  Provider = 'provider',
  Admin = 'admin',
}
