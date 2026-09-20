export enum FilePurpose {
  Avatar = 'avatar',
  Document = 'document',
  ServicePhoto = 'service_photo',
  PackPhoto = 'pack_photo',
  Attachment = 'attachment',
  Evidence = 'evidence',
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
  CommercialRegisterOrArtisanCard = 'commercial_register_or_artisan_card',
  TaxCard = 'tax_card',
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
