// //
// The store (lib/api.ts + store/mutations.ts) owns every call that produces a
// Delta the board cares about. Attachments are the one thing it doesn't carry,
// so the panel talks to REST directly — matching apps/api/src/routes/attachments.ts:
//
//   POST /api/tasks/:taskId/attachments?filename=...   raw file bytes (streamed)
//   GET  /api/attachments/:id                          raw bytes (thumbnail/download)
//
import type { Attachment } from "@flow/shared";
import { ApiError } from "../lib/api.js";

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  let res: Response;
  try {
    const qs = new URLSearchParams({ filename: file.name });
    res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments?${qs}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      // Raw bytes: the route streams the body straight into R2 and requires
      // Content-Length, which the browser sets from the File.
      body: file,
      credentials: "same-origin",
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "Network unreachable");
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          detail = parsed.error ?? parsed.message ?? text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200);
        }
      }
    } catch {
      /* keep the status line */
    }
    throw new ApiError(res.status, detail);
  }

  return (await res.json()) as Attachment;
}

export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}
