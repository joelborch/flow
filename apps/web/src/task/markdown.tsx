// //
// A compact CommonMark-subset renderer that emits Preact VNodes directly.
// Nothing here ever touches innerHTML / dangerouslySetInnerHTML, so there is no
// HTML string to sanitize: text becomes text nodes and the only attributes we
// ever set are href/src, both passed through an allowlist (safeUrl). That makes
// the sanitizer trivially auditable and drops the `marked` dependency.
//
// Supported: ATX headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`,
// fenced code blocks, links + autolinks, images, ordered/unordered lists with
// nesting, task-list checkboxes, blockquotes, horizontal rules, hard breaks.
import type { VNode } from "preact";

// --- URL allowlist ---------------------------------------------------------

const SCHEME_OK = /^(?:https?:\/\/|mailto:)/i;

export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Strip whitespace and control characters so "java\nscript:" can't slip past
  // the scheme check. Hyphens and the rest of the URL are left intact.
  const t = raw.replace(/[\s\u0000-\u001f\u007f]/g, "");
  if (SCHEME_OK.test(t)) return t;
  // Same-origin relative links and in-page anchors.
  if (/^(?:\/|#|\.{1,2}\/)/.test(t)) return t;
  // Bare email.
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(t)) return `mailto:${t}`;
  return undefined; // javascript:, data:, vbscript:, everything else
}

// --- typography ------------------------------------------------------------
// The description is the centerpiece: 15px body, 1.65 leading, ~64ch measure.

// Imported descriptions are full of bare URLs and ClickUp attachment links that
// run well past 64ch as a single unbroken token. Without an explicit break rule
// they widen the block, which widens the panel's scroll container, and the whole
// task detail gains a horizontal scrollbar. `break-words` here is
// overflow-wrap:anywhere — it only splits a word that would otherwise overflow.
const BREAK = "break-words";

const S = {
  p: `mt-3.5 text-[15px] leading-[1.65] text-text ${BREAK}`,
  h1: `mt-7 mb-1.5 text-[19px] font-semibold tracking-[-0.015em] text-text ${BREAK}`,
  h2: `mt-6 mb-1.5 text-[16.5px] font-semibold tracking-[-0.012em] text-text ${BREAK}`,
  h3: `mt-5 mb-1 text-[14.5px] font-semibold text-text ${BREAK}`,
  h4: `mt-4 mb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted ${BREAK}`,
  ul: "mt-3 space-y-1.5 pl-5 text-[15px] list-disc marker:text-faint",
  ol: "mt-3 space-y-1.5 pl-5 text-[15px] list-decimal marker:text-[13px] marker:font-medium marker:text-faint",
  li: `text-[15px] leading-[1.6] text-text ${BREAK} [&>ul]:mt-1.5 [&>ol]:mt-1.5 [&>p]:mt-0`,
  tasks: "mt-3 space-y-1.5",
  code: "mt-4 overflow-x-auto rounded-lg border border-line bg-bg px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-text scroll-y",
  inlineCode: `rounded bg-bg px-1.5 py-[1px] font-mono text-[0.86em] text-text ${BREAK}`,
  quote: `mt-4 border-l-2 border-line pl-4 text-[15px] leading-[1.65] text-muted ${BREAK} [&>p]:mt-2 [&>p:first-child]:mt-0`,
  hr: "my-6 border-0 border-t border-line",
  a: `font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent ${BREAK}`,
  img: "mt-4 max-w-full rounded-lg border border-line",
  // A table is the one block that legitimately wants to be wider than the
  // measure, so it scrolls inside its own box instead of stretching the column.
  tableWrap: "mt-4 max-w-full overflow-x-auto rounded-lg border border-line scroll-y",
  table: "w-full border-collapse text-[13.5px]",
  th: "border-b border-line bg-bg px-3 py-2 text-left align-top font-semibold text-text",
  td: "border-b border-line px-3 py-2 align-top text-text last:border-b-0",
} as const;

/** Wrapper class for a rendered markdown body. */
export const PROSE = "min-w-0 max-w-[64ch] [&>*:first-child]:mt-0";

// --- inline ----------------------------------------------------------------

const INLINE_SRC = [
  "(`+)([\\s\\S]*?)\\1", //                                     1,2  code span
  "\\*\\*([\\s\\S]+?)\\*\\*", //                                3    strong
  "__([\\s\\S]+?)__", //                                        4    strong
  "\\*([^*\\n]+?)\\*", //                                       5    em
  "(?<![A-Za-z0-9])_([^_\\n]+?)_(?![A-Za-z0-9])", //            6    em
  "~~([\\s\\S]+?)~~", //                                        7    strike
  "!\\[([^\\]]*)\\]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))*)[^)]*\\)", //   8,9  image
  "\\[([^\\]]*)\\]\\(\\s*((?:[^()\\s]|\\([^()\\s]*\\))*)[^)]*\\)", //    10,11 link
  "<((?:https?://|mailto:)[^>\\s]+)>", //                       12   autolink
  // 13  bare URL. Imported comments are often forwarded email, where a
  // link is never wrapped in markdown syntax — without this they render as dead
  // text. Ordered last so a link's own destination is consumed by 10/11 first.
  "(?<![\\w@./-])(https?://[^\\s<>()\\[\\]]+)",
].join("|");

/** Sentence punctuation that followed a bare URL rather than belonging to it. */
const URL_TAIL = /[.,;:!?'"“”’]+$/;

export function inline(src: string, key: string): (string | VNode)[] {
  // A fresh regex per call: recursion into inline() would otherwise reset
  // lastIndex on a shared global regex and truncate the outer scan.
  const re = new RegExp(INLINE_SRC, "g");
  const out: (string | VNode)[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}.${n++}`;

    if (m[1] !== undefined) {
      out.push(<code key={k} class={S.inlineCode}>{(m[2] ?? "").replace(/^ | $/g, "")}</code>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={k} class="font-semibold text-text">{inline(m[3] ?? m[4] ?? "", k)}</strong>);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<em key={k} class="italic">{inline(m[5] ?? m[6] ?? "", k)}</em>);
    } else if (m[7] !== undefined) {
      out.push(<s key={k} class="text-faint">{inline(m[7], k)}</s>);
    } else if (m[9] !== undefined) {
      const src2 = safeUrl(m[9]);
      out.push(
        src2
          ? <img key={k} src={src2} alt={m[8] ?? ""} loading="lazy" class={S.img} />
          : <span key={k} class="text-faint">{m[8] ?? ""}</span>
      );
    } else if (m[11] !== undefined) {
      const href = safeUrl(m[11]);
      const label = inline(m[10] ?? "", k);
      out.push(
        href
          ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" class={S.a}>{label}</a>
          : <span key={k}>{label}</span>
      );
    } else if (m[12] !== undefined) {
      const href = safeUrl(m[12]);
      // An autolinked address reads as the address, not as "mailto:…".
      const shown = m[12].replace(/^mailto:/i, "");
      out.push(
        href
          ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" class={S.a}>{shown}</a>
          : <span key={k}>{shown}</span>
      );
    } else if (m[13] !== undefined) {
      // Trailing sentence punctuation belongs to the prose, not to the address,
      // so it is handed back to the scan rather than swallowed by the anchor.
      const raw = m[13];
      const tail = URL_TAIL.exec(raw)?.[0] ?? "";
      const url = tail === "" ? raw : raw.slice(0, raw.length - tail.length);
      const href = safeUrl(url);
      out.push(
        href
          ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" class={S.a}>{url}</a>
          : <span key={k}>{url}</span>
      );
      last = m.index + m[0].length - tail.length;
      continue;
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Splits on hard breaks (two trailing spaces or a backslash) inside a block. */
function inlineWithBreaks(text: string, key: string): (string | VNode)[] {
  const segments = text.split(/(?: {2,}|\\)\n/);
  if (segments.length === 1) return inline(text.replace(/\n/g, " "), key);
  const out: (string | VNode)[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) out.push(<br key={`${key}.br${i}`} />);
    out.push(...inline(seg.replace(/\n/g, " "), `${key}.s${i}`));
  });
  return out;
}

// --- blocks ----------------------------------------------------------------

const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^ {0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RE_BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const RE_ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const RE_TASK = /^\[([ xX])\][ \t]+(.*)$/;
// A GFM table: a row of pipe-separated cells, then a row of dashes. Both are
// required — a lone line with a pipe in it is just a paragraph.
const RE_TABLE_ROW = /^ {0,3}\|.*\|[ \t]*$/;
const RE_TABLE_RULE = /^ {0,3}\|(?:[ \t]*:?-{1,}:?[ \t]*\|)+[ \t]*$/;

/** Splits one `| a | b |` row into its cells. */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((c) => c.trim());
}

function indentOf(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 4 : 1;
  return n;
}

type Item = { marker: "bullet" | "ordered"; checked: boolean | null; lines: string[] };

function blocks(lines: string[], key: string): VNode[] {
  const out: VNode[] = [];
  let i = 0;
  let n = 0;
  const nextKey = () => `${key}.${n++}`;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const close = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trimEnd().startsWith(close) && l.trim().replace(/[`~]/g, "") === "") { i++; break; }
        body.push(l);
        i++;
      }
      const lang = fence[2] ?? "";
      out.push(
        <pre key={nextKey()} class={S.code}>
          {lang && <span class="mb-1.5 block select-none text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">{lang}</span>}
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (RE_HR.test(line)) {
      out.push(<hr key={nextKey()} class={S.hr} />);
      i++;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      const k = nextKey();
      const kids = inline(text, k);
      out.push(
        depth === 1 ? <h1 key={k} class={S.h1}>{kids}</h1>
        : depth === 2 ? <h2 key={k} class={S.h2}>{kids}</h2>
        : depth === 3 ? <h3 key={k} class={S.h3}>{kids}</h3>
        : <h4 key={k} class={S.h4}>{kids}</h4>
      );
      i++;
      continue;
    }

    // Blockquote: consume the contiguous run, strip markers, recurse.
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i] ?? "");
        if (q) { inner.push(q[1] ?? ""); i++; continue; }
        if ((lines[i] ?? "").trim() === "") break;
        inner.push(lines[i] ?? ""); // lazy continuation
        i++;
      }
      const k = nextKey();
      out.push(<blockquote key={k} class={S.quote}>{blocks(inner, k)}</blockquote>);
      continue;
    }

    // Tables. Imported ClickUp descriptions carry them, and without this branch
    // the whole grid lands in a paragraph as a wall of pipe characters.
    if (RE_TABLE_ROW.test(line) && RE_TABLE_RULE.test(lines[i + 1] ?? "")) {
      const head = tableCells(line);
      const width = head.length;
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && RE_TABLE_ROW.test(lines[i] ?? "")) {
        const cells = tableCells(lines[i] ?? "");
        while (cells.length < width) cells.push("");
        body.push(cells.slice(0, width));
        i++;
      }
      const k = nextKey();
      out.push(
        <div key={k} class={S.tableWrap}>
          <table class={S.table}>
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={`${k}.h${c}`} class={S.th}>
                    {inline(cell, `${k}.h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={`${k}.r${r}`}>
                  {row.map((cell, c) => (
                    <td key={`${k}.r${r}c${c}`} class={S.td}>
                      {inline(cell, `${k}.r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Lists.
    const bullet = RE_BULLET.exec(line);
    const ordered = bullet ? null : RE_ORDERED.exec(line);
    if (bullet || ordered) {
      const first = bullet ?? ordered!;
      const baseIndent = indentOf(first[1] ?? "");
      const kind: Item["marker"] = bullet ? "bullet" : "ordered";
      const items: Item[] = [];

      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() === "") {
          // A blank line ends the list unless the next line continues it.
          const peek = lines[i + 1] ?? "";
          const cont = RE_BULLET.exec(peek) ?? RE_ORDERED.exec(peek);
          if (!cont || indentOf(cont[1] ?? "") < baseIndent) break;
          i++;
          continue;
        }
        const b = RE_BULLET.exec(l);
        const o = b ? null : RE_ORDERED.exec(l);
        const match = b ?? o;
        const ind = match ? indentOf(match[1] ?? "") : indentOf(/^[ \t]*/.exec(l)?.[0] ?? "");

        if (match && ind <= baseIndent + 1) {
          const isSameKind = (b ? "bullet" : "ordered") === kind;
          if (!isSameKind) break;
          let content = match[3] ?? "";
          let checked: boolean | null = null;
          const task = RE_TASK.exec(content);
          if (task) {
            checked = (task[1] ?? " ").toLowerCase() === "x";
            content = task[2] ?? "";
          }
          items.push({ marker: kind, checked, lines: [content] });
          i++;
          continue;
        }
        if (items.length > 0 && ind > baseIndent) {
          // Continuation / nested content belonging to the current item.
          const current = items[items.length - 1];
          if (current) current.lines.push(l.slice(Math.min(l.length, baseIndent + 2)));
          i++;
          continue;
        }
        break;
      }

      const k = nextKey();
      const isTaskList = items.length > 0 && items.every((it) => it.checked !== null);

      if (isTaskList) {
        out.push(
          <ul key={k} class={S.tasks}>
            {items.map((it, idx) => (
              <li key={`${k}.t${idx}`} class="flex items-start gap-2.5 text-[15px] leading-[1.6] text-text">
                <span
                  aria-hidden="true"
                  class={
                    it.checked
                      ? "mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] bg-accent text-white"
                      : "mt-[3px] h-[15px] w-[15px] shrink-0 rounded-[4px] border border-line-strong"
                  }
                >
                  {it.checked && (
                    <svg viewBox="0 0 16 16" class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3.5 8.5 6.2 11.2 12.5 5" />
                    </svg>
                  )}
                </span>
                <span class={it.checked ? "text-faint line-through decoration-line-strong" : undefined}>
                  {itemChildren(it, `${k}.t${idx}`)}
                </span>
              </li>
            ))}
          </ul>
        );
      } else if (kind === "ordered") {
        const startAttr = Number(first[2] ?? "1");
        out.push(
          <ol key={k} class={S.ol} start={startAttr === 1 ? undefined : startAttr}>
            {items.map((it, idx) => <li key={`${k}.i${idx}`} class={S.li}>{itemChildren(it, `${k}.i${idx}`)}</li>)}
          </ol>
        );
      } else {
        out.push(
          <ul key={k} class={S.ul}>
            {items.map((it, idx) => <li key={`${k}.i${idx}`} class={S.li}>{itemChildren(it, `${k}.i${idx}`)}</li>)}
          </ul>
        );
      }
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") break;
      const startsTable = RE_TABLE_ROW.test(l) && RE_TABLE_RULE.test(lines[i + 1] ?? "");
      if (
        para.length > 0 &&
        (RE_HEADING.test(l) || RE_FENCE.test(l) || RE_HR.test(l) || RE_QUOTE.test(l) ||
          RE_BULLET.test(l) || RE_ORDERED.test(l) || startsTable)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    const k = nextKey();
    out.push(<p key={k} class={S.p}>{inlineWithBreaks(para.join("\n"), k)}</p>);
  }

  return out;
}

/** An item is inline-only when it has no nested block content. */
function itemChildren(item: Item, key: string): (string | VNode)[] | VNode[] {
  const rest = item.lines.slice(1);
  const hasBlocks = rest.some((l) => l.trim() !== "");
  if (!hasBlocks) return inlineWithBreaks(item.lines[0] ?? "", key);
  return blocks(item.lines, key);
}

export function renderMarkdown(source: string): VNode[] {
  const normalized = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  return blocks(normalized.split("\n"), "md");
}

/** Rendered markdown body with reading typography. */
export function Markdown({ source, class: cls }: { source: string; class?: string }) {
  return <div class={cls ? `${PROSE} ${cls}` : PROSE}>{renderMarkdown(source)}</div>;
}
