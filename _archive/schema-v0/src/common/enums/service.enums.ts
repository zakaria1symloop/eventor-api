export enum PriceType {
  PerEvent = 'per_event',
  PerHour = 'per_hour',
  PerPerson = 'per_person',
  PerDay = 'per_day',
  OnQuote = 'on_quote',
}

export enum ServiceStatus {
  Draft = 'draft',
  Published = 'published',
  Hidden = 'hidden',
}

export enum AvailabilityKind {
  Blocked = 'blocked',
  Booked = 'booked',
  Held = 'held',
}

export enum PackStatus {
  Draft = 'draft',
  Published = 'published',
  Unpublished = 'unpublished',
}
