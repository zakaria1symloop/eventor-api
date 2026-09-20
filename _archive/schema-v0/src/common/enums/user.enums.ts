export enum UserRole {
  Client = 'client',
  Provider = 'provider',
  Academic = 'academic',
  Admin = 'admin',
}

export enum UserStatus {
  Active = 'active',
  Blocked = 'blocked',
}

export enum VerificationStatus {
  NotRequired = 'not_required',
  Pending = 'pending',
  Verified = 'verified',
  Rejected = 'rejected',
}

export enum Language {
  Ar = 'ar',
  En = 'en',
  Fr = 'fr',
}

export enum InstitutionType {
  PublicUniversity = 'public_university',
  PrivateSchool = 'private_school',
  ResearchCenter = 'research_center',
  Association = 'association',
  Other = 'other',
}

/** Session / device-token platform. */
export enum Platform {
  Web = 'web',
  Android = 'android',
  Ios = 'ios',
}
