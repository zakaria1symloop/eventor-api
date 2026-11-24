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

/** Who made a manual block (BUG-F6/M1): the provider in the app, or Eventor from the dashboard. */
export enum AvailabilitySource {
  Provider = 'provider',
  Admin = 'admin',
}

export enum PackStatus {
  Draft = 'draft',
  Published = 'published',
  Unpublished = 'unpublished',
}
