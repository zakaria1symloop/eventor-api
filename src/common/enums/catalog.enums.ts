export enum WilayaRegion {
  NorthCentre = 'north_centre',
  NorthEast = 'north_east',
  NorthWest = 'north_west',
  Highlands = 'highlands',
  South = 'south',
}

/** Shared by packs, bookings and academic requests. */
export enum EventType {
  Wedding = 'wedding',
  Engagement = 'engagement',
  Henna = 'henna',
  Birthday = 'birthday',
  Circumcision = 'circumcision',
  Graduation = 'graduation',
  Corporate = 'corporate',
  Conference = 'conference',
  Academic = 'academic',
  Other = 'other',
}

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
  Held = 'held',
  Booked = 'booked',
}

export enum PackStatus {
  Draft = 'draft',
  Published = 'published',
  Unpublished = 'unpublished',
}
