export function buildUsEquityCalendar(options: { startDate: string; endDate: string }): {
  status: string; marketSessions: string[]; calendarCoverage: { startDate: string; endDate: string; confirmed: boolean } | null;
};
