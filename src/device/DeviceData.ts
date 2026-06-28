// Read personal context the assistant needs to organise daily life: contacts,
// calendar, and current location. Each requests its runtime permission on first
// use (the OS prompt is the consent gate) and returns a clean, compact result.

import * as Calendar from "expo-calendar";
import * as Contacts from "expo-contacts";
import * as Location from "expo-location";

export async function readContacts(query: string, limit = 10): Promise<Record<string, unknown>> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== "granted") return { ok: false, error: "Contacts permission was denied." };
  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
    name: query || undefined,
  });
  const items = (data ?? []).slice(0, limit).map((c) => ({
    name: c.name,
    phones: (c.phoneNumbers ?? []).map((p) => p.number).filter(Boolean),
    emails: (c.emails ?? []).map((e) => e.email).filter(Boolean),
  }));
  return { ok: true, count: items.length, contacts: items };
}

export async function readCalendar(days = 7): Promise<Record<string, unknown>> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== "granted") return { ok: false, error: "Calendar permission was denied." };
  const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  if (!cals.length) return { ok: true, count: 0, events: [] };
  const start = new Date();
  const end = new Date(Date.now() + Math.max(1, days) * 86400000);
  const events = await Calendar.getEventsAsync(
    cals.map((c) => c.id),
    start,
    end
  );
  const items = events
    .slice(0, 60)
    .map((e) => ({ title: e.title, start: e.startDate, end: e.endDate, location: e.location, allDay: e.allDay }));
  return { ok: true, count: items.length, events: items };
}

export async function getLocation(): Promise<Record<string, unknown>> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return { ok: false, error: "Location permission was denied." };
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  let address: string | undefined;
  try {
    const geo = await Location.reverseGeocodeAsync({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    });
    if (geo[0]) {
      const g = geo[0];
      address = [g.name, g.street, g.city, g.region, g.postalCode, g.country].filter(Boolean).join(", ");
    }
  } catch {
    // geocoding is best-effort
  }
  return { ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude, address };
}
