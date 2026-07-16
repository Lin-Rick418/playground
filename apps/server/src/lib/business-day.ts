type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

function readCalendarDate(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = new Map(parts.map(({ type, value }) => [type, value]));

  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
  };
}

function readTimeZoneOffsetMs(instantMs: number, timeZone: string) {
  const roundedInstantMs = Math.floor(instantMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(roundedInstantMs));
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  const representedAsUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second")),
  );

  return representedAsUtc - roundedInstantMs;
}

function calendarMidnightToUtc(date: CalendarDate, timeZone: string) {
  const targetWallClockMs = Date.UTC(date.year, date.month - 1, date.day);
  let candidateMs = targetWallClockMs;

  // Offset changes can occur around a date boundary. Re-evaluate against the
  // candidate instant until it stabilizes instead of assuming a fixed offset.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const nextCandidateMs = targetWallClockMs - readTimeZoneOffsetMs(candidateMs, timeZone);

    if (nextCandidateMs === candidateMs) {
      break;
    }

    candidateMs = nextCandidateMs;
  }

  return new Date(candidateMs);
}

function nextCalendarDate(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function formatCalendarDate(date: CalendarDate) {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day
    .toString()
    .padStart(2, "0")}`;
}

export function assertValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`BUSINESS_TIME_ZONE must be a valid IANA time zone; received ${JSON.stringify(timeZone)}`);
  }
}

export function getBusinessDayWindow(instant: Date, timeZone: string) {
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Business-day calculation requires a valid instant");
  }

  assertValidTimeZone(timeZone);
  const date = readCalendarDate(instant, timeZone);

  return {
    date: formatCalendarDate(date),
    start: calendarMidnightToUtc(date, timeZone),
    end: calendarMidnightToUtc(nextCalendarDate(date), timeZone),
    timeZone,
  };
}
