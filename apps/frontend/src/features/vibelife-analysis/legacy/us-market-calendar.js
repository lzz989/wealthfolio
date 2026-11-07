// Public exchange schedule, independent of prices and personal portfolio records.
// Source verified 2026-10-28: https://nasdaqtrader.com/Trader.aspx?id=Calendar
// Coverage deliberately stops at the verified calendar; quote absence is never a holiday.
const SOURCE = "https://nasdaqtrader.com/Trader.aspx?id=Calendar";
const COVERAGE_START = "2026-01-01";
const COVERAGE_END = "2026-12-31";
const CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24"]);

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Return an inclusive, independently verified NASDAQ session schedule. */
export function buildUsEquityCalendar({ startDate, endDate } = {}) {
  const fail = (code, message) => ({
    status: "unavailable", marketSessions: [], calendarCoverage: null,
    reasons: [{ code, message }], source: SOURCE,
  });
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    return fail("invalid-calendar-range", "交易日历起止日期无效。");
  }
  if (startDate < COVERAGE_START || endDate > COVERAGE_END) {
    return fail("calendar-range-unverified", "所选日期超出已核对的 2026 年交易日历覆盖范围。");
  }
  const marketSessions = [];
  const earlyCloseSessions = [];
  for (let day = Date.parse(`${startDate}T00:00:00Z`); day <= Date.parse(`${endDate}T00:00:00Z`); day += 86400000) {
    const date = new Date(day);
    const key = date.toISOString().slice(0, 10);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6 || CLOSED.has(key)) continue;
    marketSessions.push(key);
    if (EARLY_CLOSE.has(key)) earlyCloseSessions.push(key);
  }
  return {
    status: "ready", marketSessions, earlyCloseSessions, reasons: [], source: SOURCE,
    calendarCoverage: {
      startDate, endDate, confirmed: true, source: SOURCE, verifiedOn: "2026-10-28",
    },
  };
}
