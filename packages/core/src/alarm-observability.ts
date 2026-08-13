export type AlarmLogRecord = {
  event: "flow.alarm.start" | "flow.alarm.job" | "flow.alarm.finish";
  [key: string]: string | number | boolean;
};

/** Stable JSON for Workers Logs queries; callers must pass metadata only. */
export function alarmLog(record: AlarmLogRecord): string {
  return JSON.stringify(record);
}
