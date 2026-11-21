/* ══════════════════════════════════════════════════════════
   Tastings — Victorian public holidays (metropolitan Melbourne).

   Sources, read 13 Nov 2026:
   - Business Victoria, "Victorian public holidays 2026" and "… 2027"
     https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026
     https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027
   - Fair Work Ombudsman, 2026 and 2027 public holidays (Victoria)
     https://www.fairwork.gov.au/employment-conditions/public-holidays/2026-public-holidays
     https://www.fairwork.gov.au/employment-conditions/public-holidays/2027-public-holidays

   Notes
   - Boxing Day 2026 falls on a Saturday, so Monday 28 December 2026 is an extra public holiday.
   - Christmas Day and Boxing Day 2027 fall on a weekend, so Monday 27 and Tuesday 28 December
     2027 are extra public holidays.
   - Anzac Day is kept on the day it falls; Victoria gives no replacement day.
   - NOT INCLUDED: the Friday before the AFL Grand Final 2027. Its date was not fixed when this
     list was made ("subject to AFL schedule"). Add it in Settings once it is announced.
   - Public holidays follow where you are based (Victoria), not the store you visit.
   - `day` is the weekday as published; tests check every date really falls on it.
   ══════════════════════════════════════════════════════════ */

export const HOLIDAYS_VIC = [
  { date: "2026-01-01", day: "Thursday",  name: "New Year's Day" },
  { date: "2026-01-26", day: "Monday",    name: "Australia Day" },
  { date: "2026-03-09", day: "Monday",    name: "Labour Day" },
  { date: "2026-04-03", day: "Friday",    name: "Good Friday" },
  { date: "2026-04-04", day: "Saturday",  name: "Saturday before Easter Sunday" },
  { date: "2026-04-05", day: "Sunday",    name: "Easter Sunday" },
  { date: "2026-04-06", day: "Monday",    name: "Easter Monday" },
  { date: "2026-04-25", day: "Saturday",  name: "Anzac Day" },
  { date: "2026-06-08", day: "Monday",    name: "King's Birthday" },
  { date: "2026-09-25", day: "Friday",    name: "Friday before the AFL Grand Final" },
  { date: "2026-11-03", day: "Tuesday",   name: "Melbourne Cup" },
  { date: "2026-12-25", day: "Friday",    name: "Christmas Day" },
  { date: "2026-12-26", day: "Saturday",  name: "Boxing Day" },
  { date: "2026-12-28", day: "Monday",    name: "Boxing Day (extra day)" },

  { date: "2027-01-01", day: "Friday",    name: "New Year's Day" },
  { date: "2027-01-26", day: "Tuesday",   name: "Australia Day" },
  { date: "2027-03-08", day: "Monday",    name: "Labour Day" },
  { date: "2027-03-26", day: "Friday",    name: "Good Friday" },
  { date: "2027-03-27", day: "Saturday",  name: "Saturday before Easter Sunday" },
  { date: "2027-03-28", day: "Sunday",    name: "Easter Sunday" },
  { date: "2027-03-29", day: "Monday",    name: "Easter Monday" },
  { date: "2027-04-25", day: "Sunday",    name: "Anzac Day" },
  { date: "2027-06-14", day: "Monday",    name: "King's Birthday" },
  { date: "2027-11-02", day: "Tuesday",   name: "Melbourne Cup" },
  { date: "2027-12-25", day: "Saturday",  name: "Christmas Day" },
  { date: "2027-12-26", day: "Sunday",    name: "Boxing Day" },
  { date: "2027-12-27", day: "Monday",    name: "Christmas Day (extra day)" },
  { date: "2027-12-28", day: "Tuesday",   name: "Boxing Day (extra day)" }
];

/** The last date this list can be trusted for. */
export const HOLIDAYS_THROUGH = "2027-12-31";

/** Map(date → name) = built-in list + the user's added dates − the user's removed dates. */
export function holidayMap(config) {
  const map = new Map();
  for (const h of HOLIDAYS_VIC) map.set(h.date, h.name);
  const c = config || {};
  for (const h of Array.isArray(c.holidaysAdded) ? c.holidaysAdded : []) {
    if (h && typeof h.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h.date)) map.set(h.date, h.name || "Public holiday");
  }
  for (const d of Array.isArray(c.holidaysRemoved) ? c.holidaysRemoved : []) map.delete(d);
  return map;
}
