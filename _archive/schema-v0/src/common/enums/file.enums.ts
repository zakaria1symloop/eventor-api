export enum FilePurpose {
  Avatar = 'avatar',
  Document = 'document',
  ServicePhoto = 'service_photo',
  PackPhoto = 'pack_photo',
  Attachment = 'attachment',
  Invoice = 'invoice',
  Export = 'export',
  Message = 'message',
}

export enum FileProcessingStatus {
  Pending = 'pending',
  Ready = 'ready',
  Failed = 'failed',
}

export enum FileVariantKind {
  Thumb = 'thumb',
  Medium = 'medium',
  Large = 'large',
}

export enum DocumentType {
  NationalId = 'national_id',
  CommercialRegister = 'commercial_register',
  TaxCard = 'tax_card',
  ArtisanCard = 'artisan_card',
  DirectorId = 'director_id',
  Accreditation = 'accreditation',
  Authorisation = 'authorisation',
  Statutes = 'statutes',
}

export enum DocumentStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

export enum DocumentRejectReason {
  Unreadable = 'unreadable',
  Expired = 'expired',
  NameMismatch = 'name_mismatch',
  WrongDocument = 'wrong_document',
  Other = 'other',
}
