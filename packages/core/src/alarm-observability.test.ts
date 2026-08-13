import { describe, expect, it } from "vitest";
import { alarmLog } from "./alarm-observability.js";

describe("alarmLog", () => {
  it("serializes safe alarm metadata as stable JSON", () => {
    expect(
      alarmLog({
        event: "flow.alarm.job",
        job_id: 12,
        job_kind: "due_date_check",
        status: "ok",
        duration_ms: 31,
        processed: 4,
      })
    ).toBe(
      '{"event":"flow.alarm.job","job_id":12,"job_kind":"due_date_check","status":"ok","duration_ms":31,"processed":4}'
    );
  });
});
