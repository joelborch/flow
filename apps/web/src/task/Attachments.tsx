// Images get thumbnails, everything else gets a row.
import type { Attachment } from "@flow/shared";
import { formatBytes, relativeTime } from "../shell/format.js";
import { Paperclip, SectionLabel, Upload } from "../shell/ui.js";
import { attachmentUrl } from "./api.js";

function isImage(a: Attachment): boolean {
  return a.mimeType.startsWith("image/");
}

export function Attachments({
  attachments,
  uploading,
  error,
  onPick,
}: {
  attachments: Attachment[];
  uploading: string[];
  error: string | null;
  onPick: (files: File[]) => void;
}) {
  const rows = [...attachments].sort((a, b) => a.createdAt - b.createdAt);
  const images = rows.filter(isImage);
  const files = rows.filter((a) => !isImage(a));

  return (
    <section>
      <SectionLabel
        right={
          <label class="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium normal-case tracking-normal text-muted hover:bg-bg hover:text-text sm:px-1.5 sm:py-0.5">
            <Upload class="h-3 w-3" />
            Add file
            <input
              type="file"
              multiple
              class="hidden"
              onChange={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                onPick(Array.from(input.files ?? []));
                input.value = "";
              }}
            />
          </label>
        }
      >
        Attachments
      </SectionLabel>

      {rows.length === 0 && uploading.length === 0 && (
        <p class="text-[13px] text-faint">Drop a file anywhere on this panel to attach it.</p>
      )}

      {images.length > 0 && (
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((a) => (
            <a
              key={a.id}
              href={attachmentUrl(a.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={`${a.filename} · ${formatBytes(a.size)}`}
              class="group relative block aspect-[4/3] overflow-hidden rounded-lg border border-line bg-raised"
            >
              <img
                src={attachmentUrl(a.id)}
                alt={a.filename}
                loading="lazy"
                class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              />
              <span class="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] font-medium text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                {a.filename}
              </span>
            </a>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <ul class={images.length > 0 ? "mt-2 space-y-1" : "space-y-1"}>
          {files.map((a) => (
            <li key={a.id}>
              <a
                href={attachmentUrl(a.id)}
                target="_blank"
                rel="noopener noreferrer"
                class="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-raised sm:py-1.5"
              >
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg text-muted">
                  <Paperclip class="h-3.5 w-3.5" />
                </span>
                <span class="min-w-0 flex-1 truncate text-[13px] text-text">{a.filename}</span>
                <span class="shrink-0 text-[11.5px] tabular-nums text-faint">{formatBytes(a.size)}</span>
                <span class="hidden shrink-0 text-[11.5px] text-faint sm:inline">
                  {relativeTime(a.createdAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {uploading.length > 0 && (
        <ul class="mt-1 space-y-1">
          {uploading.map((name) => (
            <li key={name} class="flex items-center gap-2.5 px-0 py-1.5 text-[13px] text-faint">
              <span class="h-7 w-7 shrink-0 animate-pulse rounded-md bg-bg" />
              <span class="min-w-0 flex-1 truncate">{name}</span>
              <span class="text-[11.5px]">uploading…</span>
            </li>
          ))}
        </ul>
      )}

      {error && <p class="mt-1.5 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
