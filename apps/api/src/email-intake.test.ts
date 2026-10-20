import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_INGEST_PERMANENT_ERROR, type IngestEmailInput, type IngestEmailResult } from "@flow/core";
import { LIMITS } from "@flow/shared";
import type { Env } from "./env.js";
import { ApiError } from "./errors.js";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  findOwnerActor: vi.fn(),
}));

// @flow/core's index pulls in the DO class, whose base class only exists in workerd.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("./do.js", () => ({ workspace: mocks.workspace }));
vi.mock("./auth.js", () => ({ findOwnerActor: mocks.findOwnerActor }));

import {
  ACK_SUBJECT,
  BODY_SOURCE_MAX,
  HEADER_VALUE_MAX_BYTES,
  MAX_ATTACHMENTS,
  MAX_REFERENCE_IDS,
  PERMANENT_REJECT,
  REJECT_REASONS,
  UNVERIFIED_NOTE,
  attachmentFilename,
  authenticationLog,
  bodyText,
  classifyMail,
  decodeEntities,
  deleteUploads,
  escapeImageSyntax,
  fallbackMessageId,
  formatCommentBody,
  formatDescription,
  formatSender,
  handleEmail,
  hardBreaks,
  htmlToText,
  isCloudflareAuthservId,
  isPermanentIngestError,
  normalizeSender,
  parseAlias,
  parseAuthResults,
  referenceIds,
  senderAuthentication,
  stripQuotedReply,
  threadingHeaders,
  titleFromSubject,
  truncateWithNote,
  type MessageNotes,
  type RawHeader,
} from "./email-intake.js";
import { DEFAULT_EMAIL_FROM } from "./side-effects/index.js";

const VERIFIED: MessageNotes = { authenticated: true, skippedAttachments: 0 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseAlias / normalizeSender", () => {
  it("takes the lowercased local part and drops a +suffix", () => {
    expect(parseAlias("Acme@tickets.example.com")).toBe("acme");
    expect(parseAlias("acme+urgent@tickets.example.com")).toBe("acme");
    expect(parseAlias("<Front.Desk@tickets.example.com>")).toBe("front.desk");
  });

  it("lowercases the envelope sender and maps the null sender to empty", () => {
    expect(normalizeSender(" Jane@Example.COM ")).toBe("jane@example.com");
    expect(normalizeSender("<>")).toBe("");
    expect(normalizeSender("")).toBe("");
  });
});

describe("classifyMail", () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);

  it("treats the null sender, mailer-daemon and postmaster as bounces", () => {
    expect(classifyMail("", h())).toBe("bounce");
    expect(classifyMail("mailer-daemon@mx.example.com", h())).toBe("bounce");
    expect(classifyMail("postmaster@example.com", h())).toBe("bounce");
  });

  it("recognises auto-replies by header and by the usual subjects", () => {
    expect(classifyMail("jane@example.com", h({ "Auto-Submitted": "auto-replied" }))).toBe("auto_reply");
    expect(classifyMail("jane@example.com", h({ "Auto-Submitted": "Auto-Replied; owner=x" }))).toBe(
      "auto_reply"
    );
    expect(classifyMail("jane@example.com", h({ "X-Autoreply": "yes" }))).toBe("auto_reply");
    expect(classifyMail("jane@example.com", h({ "X-Autorespond": "on" }))).toBe("auto_reply");
    expect(classifyMail("jane@example.com", h({ Subject: "Automatic reply: Printer" }))).toBe("auto_reply");
    expect(classifyMail("jane@example.com", h({ Subject: "Out of Office AutoReply: Printer" }))).toBe(
      "auto_reply"
    );
    // RFC 2047-encoded subjects are decoded before matching.
    expect(
      classifyMail("jane@example.com", h({ Subject: "=?UTF-8?Q?Automatic_reply:_Caf=C3=A9?=" }))
    ).toBe("auto_reply");
  });

  it("marks bulk and auto-generated mail as automated (ticket allowed, no ack)", () => {
    const automated: Record<string, string>[] = [
      { "Auto-Submitted": "auto-generated" },
      { Precedence: "bulk" },
      { Precedence: "list" },
      { Precedence: "junk" },
      { Precedence: "auto_reply" },
      { "List-Id": "<news.example.com>" },
      { "List-Unsubscribe": "<mailto:unsub@example.com>" },
      { "X-Auto-Response-Suppress": "All" },
    ];
    for (const init of automated) {
      expect(classifyMail("jane@example.com", h(init))).toBe("automated");
    }
    expect(classifyMail("noreply@example.com", h())).toBe("automated");
    expect(classifyMail("do-not-reply+x@example.com", h())).toBe("automated");
  });

  it("leaves ordinary mail personal, including Auto-Submitted: no", () => {
    expect(classifyMail("jane@example.com", h())).toBe("personal");
    expect(classifyMail("jane@example.com", h({ "Auto-Submitted": "no" }))).toBe("personal");
    expect(classifyMail("noreen@example.com", h({ Subject: "Out of office supplies" }))).toBe("personal");
  });
});

// ---------------------------------------------------------------------------
// Sender authentication
// ---------------------------------------------------------------------------

const hdr = (key: string, value: string): RawHeader => ({ key, value });
const cfArc = (results: string, authserv = "mx.cloudflare.net"): RawHeader =>
  hdr("arc-authentication-results", `i=1; ${authserv}; ${results}`);
const cfAr = (results: string, authserv = "mx.cloudflare.net"): RawHeader =>
  hdr("authentication-results", `${authserv}; ${results}`);

/** What Cloudflare's receiving MTA is expected to write for an aligned Google Workspace sender. */
const CF_RESULTS =
  "dkim=pass header.d=example.com header.s=google header.b=AbC123; " +
  "dmarc=pass header.from=example.com policy.dmarc=none; " +
  "spf=pass (mx.cloudflare.net: domain of jane@example.com designates 192.0.2.1 as permitted sender) " +
  "smtp.mailfrom=jane@example.com; arc=none smtp.remote-ip=192.0.2.1";

describe("parseAuthResults", () => {
  it("reads the ARC instance, the authserv-id and each method's properties", () => {
    const parsed = parseAuthResults(`i=2; MX.Cloudflare.NET; ${CF_RESULTS}`);
    expect(parsed.instance).toBe(2);
    expect(parsed.authservId).toBe("mx.cloudflare.net");
    expect(parsed.results.map((r) => [r.method, r.result])).toEqual([
      ["dkim", "pass"],
      ["dmarc", "pass"],
      ["spf", "pass"],
      ["arc", "none"],
    ]);
    expect(parsed.results[0]!.props.get("header.d")).toBe("example.com");
    expect(parsed.results[2]!.props.get("smtp.mailfrom")).toBe("jane@example.com");
  });

  it("drops comments and keeps quoted strings whole, so neither can add a clause or a property", () => {
    const parsed = parseAuthResults(
      'mx.cloudflare.net; spf=fail (x; dkim=pass header.d=example.com) smtp.mailfrom=a.example; ' +
        'dkim=fail reason="dkim=pass header.d=example.com; spf=pass" header.d=b.example'
    );
    expect(parsed.instance).toBeNull();
    expect(parsed.results.map((r) => [r.method, r.result, [...r.props]])).toEqual([
      ["spf", "fail", [["smtp.mailfrom", "a.example"]]],
      ["dkim", "fail", [["header.d", "b.example"]]],
    ]);
  });

  it("tolerates whitespace around = and a method version", () => {
    const [result] = parseAuthResults("mx.cloudflare.net 1; dkim/1 = pass header.d = example.com").results;
    expect(result).toMatchObject({ method: "dkim", result: "pass" });
    expect(result!.props.get("header.d")).toBe("example.com");
  });
});

describe("isCloudflareAuthservId", () => {
  it("accepts Cloudflare's hosts and nothing that merely contains the name", () => {
    expect(isCloudflareAuthservId("mx.cloudflare.net")).toBe(true);
    expect(isCloudflareAuthservId("mx.cloudflare.com")).toBe(true);
    expect(isCloudflareAuthservId("cloudflare.net")).toBe(true);
    expect(isCloudflareAuthservId("evilcloudflare.net")).toBe(false);
    expect(isCloudflareAuthservId("mx.cloudflare.net.attacker.example")).toBe(false);
    expect(isCloudflareAuthservId("mx.google.com")).toBe(false);
    expect(isCloudflareAuthservId("")).toBe(false);
  });
});

describe("senderAuthentication", () => {
  const auth = (headers: RawHeader[], sender = "jane@example.com") => senderAuthentication(headers, sender);

  it("passes Cloudflare's results for an aligned sender", () => {
    expect(auth([cfArc(CF_RESULTS)])).toEqual({ authenticated: true, via: "dmarc" });
    expect(auth([cfAr(CF_RESULTS)])).toEqual({ authenticated: true, via: "dmarc" });
  });

  it("refuses the forged-MAIL-FROM attack: a pass for the attacker's own domain", () => {
    // MAIL FROM:<anyone@example.com>, signed by attacker.example, SPF permerror.
    const forged = cfArc(
      "dkim=pass header.d=attacker.example; dmarc=pass header.from=attacker.example; " +
        "spf=permerror smtp.mailfrom=jane@example.com"
    );
    expect(auth([forged])).toEqual({ authenticated: false, via: null });
  });

  it("counts DMARC only for the sender's domain or a parent of it", () => {
    expect(auth([cfArc("dmarc=pass header.from=example.com")], "jane@mail.example.com").authenticated).toBe(true);
    expect(auth([cfArc("dmarc=pass header.from=mail.example.com")]).authenticated).toBe(false);
    expect(auth([cfArc("dmarc=pass")]).authenticated).toBe(false);
    expect(auth([cfArc("dmarc=fail header.from=example.com")]).authenticated).toBe(false);
  });

  it("counts DKIM for header.d equal to or a parent of the sender's domain", () => {
    expect(auth([cfArc("dkim=pass header.d=example.com")])).toEqual({ authenticated: true, via: "dkim" });
    expect(auth([cfArc("dkim=pass header.d=example.com")], "jane@mail.example.com").authenticated).toBe(true);
    expect(auth([cfArc("dkim=pass header.i=@example.com")]).authenticated).toBe(true);
    expect(auth([cfArc("dkim=pass header.d=mail.example.com")]).authenticated).toBe(false);
    expect(auth([cfArc("dkim=pass header.d=notexample.com")]).authenticated).toBe(false);
    expect(auth([cfArc("dkim=fail header.d=example.com")]).authenticated).toBe(false);
  });

  it("counts SPF only for smtp.mailfrom in the sender's own domain", () => {
    expect(auth([cfArc("spf=pass smtp.mailfrom=jane@example.com")])).toEqual({ authenticated: true, via: "spf" });
    expect(auth([cfArc("spf=pass smtp.mailfrom=example.com")]).authenticated).toBe(true);
    expect(auth([cfArc("spf=pass smtp.mailfrom=bob@attacker.example")]).authenticated).toBe(false);
    expect(auth([cfArc("spf=pass smtp.mailfrom=jane@sub.example.com")]).authenticated).toBe(false);
    expect(auth([cfArc("spf=softfail smtp.mailfrom=jane@example.com")]).authenticated).toBe(false);
  });

  it("ignores results from any other authserv-id", () => {
    expect(auth([cfArc(CF_RESULTS, "mx.google.com")]).authenticated).toBe(false);
    expect(auth([cfAr(CF_RESULTS, "mx.cloudflare.net.attacker.example")]).authenticated).toBe(false);
  });

  it("reads only the topmost header of each kind, so a sender's own copy below Cloudflare's is ignored", () => {
    const real = cfArc("dkim=pass header.d=attacker.example; spf=permerror smtp.mailfrom=jane@example.com");
    const forged = cfArc("dmarc=pass header.from=example.com");
    expect(auth([real, forged]).authenticated).toBe(false);
    // Same for plain Authentication-Results under a non-Cloudflare topmost one.
    expect(auth([cfAr("none", "mx.attacker.example"), cfAr("dmarc=pass header.from=example.com")]).authenticated).toBe(
      false
    );
  });

  it("is not fooled by a comment or a reason that reads like a pass", () => {
    expect(
      auth([cfArc("spf=fail (mx.cloudflare.net: dkim=pass; header.d=example.com) smtp.mailfrom=bob@attacker.example")])
        .authenticated
    ).toBe(false);
    expect(
      auth([cfArc('dkim=fail reason="dkim=pass header.d=example.com" header.d=attacker.example')]).authenticated
    ).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(auth([hdr("ARC-Authentication-Results", "i=1; MX.CLOUDFLARE.NET; DKIM=Pass Header.D=Example.COM")]))
      .toEqual({ authenticated: true, via: "dkim" });
  });

  it("fails safe with no results, no sender, or a no-result header", () => {
    expect(auth([])).toEqual({ authenticated: false, via: null });
    expect(auth([hdr("received-spf", "pass (mx.cloudflare.net)")]).authenticated).toBe(false);
    expect(auth([cfArc(CF_RESULTS)], "").authenticated).toBe(false);
    expect(auth([cfAr("none")]).authenticated).toBe(false);
  });
});

describe("authenticationLog", () => {
  it("logs result tokens and domains, never local parts or comments", () => {
    const headers = [
      cfArc(CF_RESULTS),
      hdr("received-spf", "pass (mx.cloudflare.net: domain of jane@example.com designates 192.0.2.1) receiver=x"),
      hdr("received", "from mail.example.com by mx.cloudflare.net"),
      hdr("authentication-results", "jane@example.com; dmarc=pass header.from=jane@example.com"),
    ];
    const log = authenticationLog(headers);
    expect(log).toEqual({
      authHeaders: [
        {
          h: "arc-authentication-results",
          pos: 0,
          i: 1,
          authserv: "mx.cloudflare.net",
          cf: true,
          dmarc: [{ r: "pass", d: "example.com" }],
          dkim: [{ r: "pass", d: "example.com" }],
          spf: [{ r: "pass", d: "example.com" }],
        },
        {
          h: "authentication-results",
          pos: 3,
          i: null,
          authserv: "?",
          cf: false,
          dmarc: [{ r: "pass", d: "example.com" }],
          dkim: [],
          spf: [],
        },
      ],
      authHeaderCount: 2,
      firstReceivedPos: 2,
      receivedSpf: "pass",
    });
    expect(JSON.stringify(log)).not.toContain("jane");
    expect(JSON.stringify(log)).not.toContain("192.0.2.1");
  });

  it("caps how many headers it describes", () => {
    const log = authenticationLog(Array.from({ length: 50 }, () => cfArc(CF_RESULTS)));
    expect((log.authHeaders as unknown[]).length).toBe(8);
    expect(log.authHeaderCount).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("titleFromSubject", () => {
  it("collapses whitespace and strips reply/forward prefixes", () => {
    expect(titleFromSubject("Re: FW:  Printer \n  broken")).toBe("Printer broken");
    expect(titleFromSubject("RE: Fwd: Re[2]: printer jam")).toBe("printer jam");
    expect(titleFromSubject("Renewal notice")).toBe("Renewal notice");
  });

  it("falls back for a blank or prefix-only subject", () => {
    expect(titleFromSubject(undefined)).toBe("(no subject)");
    expect(titleFromSubject("  ")).toBe("(no subject)");
    expect(titleFromSubject("Re:")).toBe("(no subject)");
  });

  it("caps at LIMITS.titleMax", () => {
    const title = titleFromSubject("a".repeat(LIMITS.titleMax + 50));
    expect(title).toHaveLength(LIMITS.titleMax);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("formatSender", () => {
  it("shows the display name beside the envelope address", () => {
    expect(formatSender("Jane Doe", "jane@example.com")).toBe("Jane Doe <jane@example.com>");
    expect(formatSender("Jane (Front Desk)", "jane@example.com")).toBe("Jane \\(Front Desk\\) <jane@example.com>");
  });

  it("escapes markdown in the name so it can't restyle the line", () => {
    expect(formatSender("*Jane* _[Doe]_ <x>", "jane@example.com")).toBe(
      "\\*Jane\\* \\_\\[Doe\\]\\_ \\<x\\> <jane@example.com>"
    );
    expect(formatSender("Jane\r\nBcc: x", "jane@example.com")).toBe("Jane Bcc: x <jane@example.com>");
  });

  it("escapes markdown in the address, which an @domain allowlist leaves to the sender", () => {
    expect(formatSender("", "![x](https://t.example/p)@example.com")).toBe(
      "\\!\\[x\\]\\(https://t.example/p\\)@example.com"
    );
  });

  it("uses the bare address when the name adds nothing", () => {
    expect(formatSender("", "jane@example.com")).toBe("jane@example.com");
    expect(formatSender("JANE@example.com", "jane@example.com")).toBe("jane@example.com");
    expect(formatSender(undefined, "jane@example.com")).toBe("jane@example.com");
  });
});

describe("escapeImageSyntax", () => {
  it("turns every markdown image into a non-image, leaving links alone", () => {
    expect(escapeImageSyntax("a ![pixel](https://t.example/p.gif) [link](https://x.example) ![r][1]")).toBe(
      "a !\\[pixel](https://t.example/p.gif) [link](https://x.example) !\\[r][1]"
    );
  });
});

describe("htmlToText", () => {
  it("drops style/script/head and turns blocks into lines", () => {
    const html =
      "<html><head><title>x</title><style>p{color:red}</style></head><body>" +
      "<p>Hello&nbsp;team,</p><p>Please see <a href=\"https://example.com/x?a=1&amp;b=2\">the page</a>." +
      "<br>Line two</p><ul><li>One</li><li>Two &amp; three</li></ul>" +
      "<script>alert(1)</script><div>Bye &lt;3</div></body></html>";
    expect(htmlToText(html)).toBe(
      "Hello team,\n\nPlease see the page (https://example.com/x?a=1&b=2).\nLine two\n\n- One\n- Two & three\n\nBye <3"
    );
  });

  it("keeps a link once when its text is already the URL", () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
  });

  it("collapses source whitespace and blank-line runs", () => {
    expect(htmlToText("<div>\n  a\n  b\n</div><div></div><div></div><div>c</div>")).toBe("a b\n\nc");
  });

  it("keeps link text that wraps blocks, and unquoted or single-quoted hrefs", () => {
    expect(htmlToText("<a href='https://x.example'><div>Pay now</div></a>")).toBe("Pay now (https://x.example)");
    expect(htmlToText("<a href=https://x.example>here</a>")).toBe("here (https://x.example)");
    expect(htmlToText('<a href="mailto:x@example.com">mail</a>')).toBe("mail");
  });

  it("handles unclosed and malformed markup without losing the text", () => {
    expect(htmlToText('<p>See <a href="https://x.example">the doc')).toBe("See the doc (https://x.example)");
    expect(htmlToText("<title>Subject<p>Body text")).toBe("Subject\nBody text");
    expect(htmlToText("<p>a < b and c</p><!-- hidden")).toBe("a < b and c");
    expect(htmlToText("<p>kept</p><div")).toBe("kept");
  });

  it("stays linear on pathological input", () => {
    const cases: Record<string, string> = {
      "unclosed links": '<a href="https://x.example/">'.repeat(110_000),
      "unclosed titles": "<title>x".repeat(400_000),
      "unclosed links and titles": '<a href="https://x.example/"><title>'.repeat(80_000),
      "unclosed comments": "<!--x".repeat(600_000),
      "bare angle brackets": "<".repeat(3_000_000),
      "unterminated tags": "<li".repeat(1_000_000),
      "long entity-like runs": `&#${"1".repeat(3_000_000)}`,
    };
    for (const [label, html] of Object.entries(cases)) {
      const start = performance.now();
      htmlToText(html);
      const elapsed = performance.now() - start;
      expect(elapsed, `${label}: ${elapsed.toFixed(0)} ms`).toBeLessThan(1000);
    }
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("&rsquo;&#169;&#x1F600;&AMP;")).toBe("’©😀&");
  });

  it("leaves unknown names, prototype keys and lone surrogates alone", () => {
    expect(decodeEntities("&bogus; &constructor; &#55296;")).toBe("&bogus; &constructor; &#55296;");
  });
});

describe("bodyText", () => {
  it("prefers the text part and normalises newlines", () => {
    expect(bodyText({ text: "  a\r\nb\r\n", html: "<p>ignored</p>" })).toBe("a\nb");
  });

  it("falls back to the HTML part, then to nothing", () => {
    expect(bodyText({ text: " \n", html: "<p>From html</p>" })).toBe("From html");
    expect(bodyText({ text: undefined, html: undefined })).toBe("");
  });

  it("cuts an oversized part before transforming it, and says so", () => {
    const text = bodyText({ text: "x".repeat(BODY_SOURCE_MAX * 3), html: undefined });
    expect(text.length).toBeLessThan(BODY_SOURCE_MAX + 200);
    expect(text).toContain("Truncated");
    const fromHtml = bodyText({ text: undefined, html: `<p>${"y".repeat(BODY_SOURCE_MAX * 3)}</p>` });
    expect(fromHtml.length).toBeLessThan(BODY_SOURCE_MAX + 200);
    expect(fromHtml).toContain("Truncated");
  });
});

describe("hardBreaks", () => {
  it("hard-breaks lines inside a paragraph only", () => {
    expect(hardBreaks("Thanks,\nJane\n\nNext")).toBe("Thanks,  \nJane\n\nNext");
  });
});

describe("stripQuotedReply", () => {
  it("cuts at a Gmail attribution line", () => {
    expect(
      stripQuotedReply("Works now.\n\nOn Mon, Oct 13, 2026 at 9:05 AM Jane <jane@example.com> wrote:\n> old")
    ).toBe("Works now.");
  });

  it("cuts at an attribution that wraps before 'wrote:'", () => {
    expect(
      stripQuotedReply("Works now.\n\nOn Mon, Oct 13, 2026 at 9:05 AM Jane Doe <\njane@example.com> wrote:\n> old")
    ).toBe("Works now.");
  });

  it("cuts at Outlook's Original Message separator", () => {
    expect(stripQuotedReply("Fine.\n-----Original Message-----\nFrom: x\nold")).toBe("Fine.");
  });

  it("cuts at an Outlook From:/Sent: header block and its rule", () => {
    const reply =
      "Attached.\n\n________________________________\nFrom: Example Co <flow@mail.example.com>\n" +
      "Sent: Monday, October 13, 2026 9:05 AM\nTo: Jane\nSubject: Re: Printer\n\nold text";
    expect(stripQuotedReply(reply)).toBe("Attached.");
  });

  it("drops trailing > lines but keeps inline quoting", () => {
    expect(stripQuotedReply("> you asked\nmy answer\n\n> old 1\n> old 2\n")).toBe("> you asked\nmy answer");
  });

  it("leaves a body with no quote alone, and a fully quoted one empty", () => {
    expect(stripQuotedReply("From: the front desk, all good")).toBe("From: the front desk, all good");
    expect(stripQuotedReply("> only quoted")).toBe("");
  });
});

describe("truncation and formatting", () => {
  it("leaves text under the cap untouched", () => {
    expect(truncateWithNote("short", 10)).toBe("short");
  });

  it("truncates to exactly the cap with a visible note", () => {
    const out = truncateWithNote("x".repeat(500), 200);
    expect(out).toHaveLength(200);
    expect(out).toContain("Truncated");
  });

  it("puts the From line above the body and caps the description", () => {
    expect(formatDescription("Jane <jane@example.com>", "a\nb", VERIFIED)).toBe(
      "**From:** Jane <jane@example.com>\n\na  \nb"
    );
    expect(formatDescription("j@example.com", "", VERIFIED)).toBe("**From:** j@example.com\n\n_No message text._");
    const long = formatDescription("j@example.com", "y".repeat(LIMITS.descriptionMax), VERIFIED);
    expect(long).toHaveLength(LIMITS.descriptionMax);
    expect(long).toContain("Truncated");
  });

  it("marks an unverified sender first and notes skipped attachments, above anything truncation cuts", () => {
    const description = formatDescription("j@example.com", "z".repeat(LIMITS.descriptionMax), {
      authenticated: false,
      skippedAttachments: 3,
    });
    expect(description.startsWith(`${UNVERIFIED_NOTE}\n\n**From:** j@example.com\n\n_3 more attachments were not saved`)).toBe(
      true
    );
    expect(description).toHaveLength(LIMITS.descriptionMax);
  });

  it("escapes markdown images in the body", () => {
    expect(formatDescription("j@example.com", "see ![x](https://t.example/p.gif)", VERIFIED)).toBe(
      "**From:** j@example.com\n\nsee !\\[x](https://t.example/p.gif)"
    );
    expect(formatCommentBody("j@example.com", "![x](https://t.example/p.gif)", 0, VERIFIED)).toContain("!\\[x]");
  });

  it("formats a reply comment and says so when only attachments came", () => {
    expect(formatCommentBody("j@example.com", "ok", 0, VERIFIED)).toBe("**Email reply from** j@example.com\n\nok");
    expect(formatCommentBody("j@example.com", "", 2, VERIFIED)).toBe(
      "**Email reply from** j@example.com\n\n_No message text; 2 attachments added to the task._"
    );
    expect(formatCommentBody("j@example.com", "", 0, VERIFIED)).toContain("_No message text._");
    expect(formatCommentBody("j@example.com", "z".repeat(LIMITS.commentBodyMax), 0, VERIFIED)).toHaveLength(
      LIMITS.commentBodyMax
    );
    expect(
      formatCommentBody("j@example.com", "ok", 0, { authenticated: false, skippedAttachments: 0 })
    ).toBe(`${UNVERIFIED_NOTE}\n\n**Email reply from** j@example.com\n\nok`);
  });
});

describe("attachmentFilename", () => {
  it("sanitizes the sender's name like uploads do", () => {
    expect(attachmentFilename("../../etc/passwd", 1, "text/plain")).toBe("passwd");
    expect(attachmentFilename('a"b.pdf', 1, "application/pdf")).toBe("ab.pdf");
  });

  it("falls back to attachment-N plus an extension from the type", () => {
    expect(attachmentFilename(null, 2, "image/png")).toBe("attachment-2.png");
    expect(attachmentFilename("...", 3, "application/pdf")).toBe("attachment-3.pdf");
    expect(attachmentFilename("  ", 1, "application/x-unknown")).toBe("attachment-1.bin");
  });
});

describe("threadingHeaders", () => {
  it("points at the original and appends it to its References", () => {
    expect(threadingHeaders("m3@example.com", ["m1@example.com", "m2@example.com"])).toEqual({
      "In-Reply-To": "<m3@example.com>",
      References: "<m1@example.com> <m2@example.com> <m3@example.com>",
    });
  });

  it("has nothing to point at for a synthesized id", () => {
    expect(threadingHeaders("sha256:abc", [])).toBeNull();
  });

  it("drops ids from the middle to fit the header cap, keeping the root and the newest", () => {
    const parents = Array.from({ length: 200 }, (_, i) => `id-${i}@example.com`);
    const references = threadingHeaders("last@example.com", parents)?.References ?? "";
    expect(new TextEncoder().encode(references).byteLength).toBeLessThanOrEqual(HEADER_VALUE_MAX_BYTES);
    expect(references.startsWith("<id-0@example.com> ")).toBe(true);
    expect(references.endsWith("<id-199@example.com> <last@example.com>")).toBe(true);
  });
});

describe("referenceIds / fallbackMessageId", () => {
  it("keeps In-Reply-To and the earliest References, capped", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@example.com>`).join(" ");
    const ids = referenceIds(new Headers({ "In-Reply-To": "<parent@example.com>", References: refs }));
    expect(ids).toHaveLength(MAX_REFERENCE_IDS);
    expect(ids.slice(0, 3)).toEqual(["parent@example.com", "r0@example.com", "r1@example.com"]);
  });

  it("derives the same id from the same sender-written headers and size", async () => {
    const base = { From: "Jane <jane@example.com>", Date: "Mon, 13 Oct 2026 09:05:00 -0400", Subject: "Hi", To: "a@b" };
    const a = await fallbackMessageId(new Headers({ ...base, Received: "from a by mx1" }), 1234);
    const b = await fallbackMessageId(new Headers({ ...base, Received: "from b by mx2" }), 1234);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(await fallbackMessageId(new Headers({ ...base, Subject: "Other" }), 1234)).not.toBe(a);
    expect(await fallbackMessageId(new Headers(base), 1235)).not.toBe(a);
  });
});

describe("isPermanentIngestError", () => {
  it("matches the core prefix anywhere in the message, wrapped or not", () => {
    expect(isPermanentIngestError(new Error(`${EMAIL_INGEST_PERMANENT_ERROR}: no Message-ID`))).toBe(true);
    expect(isPermanentIngestError(new ApiError(422, `${EMAIL_INGEST_PERMANENT_ERROR}: x`))).toBe(true);
    expect(isPermanentIngestError(new Error("Durable Object reset"))).toBe(false);
    expect(isPermanentIngestError("Network connection lost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The handler, against synthetic MIME
// ---------------------------------------------------------------------------

const CRLF = "\r\n";
const INTAKE_ADDRESS = "Acme+urgent@tickets.example.com";
const SENDER = "Jane@Example.com";
const CF_AUTH_HEADER = `ARC-Authentication-Results: i=1; mx.cloudflare.net; ${CF_RESULTS}`;

function mime(headers: string[], body: string): string {
  return [...headers, "", body].join(CRLF);
}

/** The same message as Cloudflare would hand it over without an authenticating result. */
function unauthenticated(raw: string): string {
  return raw.replace(`${CF_AUTH_HEADER}${CRLF}`, "");
}

const PLAIN = mime(
  [
    CF_AUTH_HEADER,
    'From: "Jane Doe" <jane@example.com>',
    "To: acme@tickets.example.com",
    "Subject: Re: FW:  Printer   is broken",
    "Message-ID: <plain-1@mail.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ],
  ["The front desk printer jams on every page.", "Tried restarting it twice.", "", "Thanks,", "Jane"].join(CRLF)
);

const HTML_ONLY = mime(
  [
    CF_AUTH_HEADER,
    "From: Jane Doe <jane@example.com>",
    "Subject: Portal down",
    "Message-ID: <html-1@mail.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ],
  "<html><body><p>The portal is down.</p><p>Since <b>9am</b>.<br>Thanks</p></body></html>"
);

const PDF_BYTES = "%PDF-1.4\nsynthetic\n";
const PNG_BYTES = "\x89PNG\r\n\x1a\nsynthetic";

const b64 = (bytes: string) => btoa(bytes).replace(/.{76}/g, `$&${CRLF}`);

const textPart = (text: string) => ["Content-Type: text/plain; charset=utf-8", "", text];
const filePart = (name: string, mimeType: string, bytes: string) => [
  `Content-Type: ${mimeType}; name="${name}"`,
  `Content-Disposition: attachment; filename="${name}"`,
  "Content-Transfer-Encoding: base64",
  "",
  b64(bytes),
];

function multipart(messageId: string, subject: string, parts: string[][], type = "mixed"): string {
  return mime(
    [
      CF_AUTH_HEADER,
      "From: Jane Doe <jane@example.com>",
      `Subject: ${subject}`,
      `Message-ID: <${messageId}>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/${type}; boundary="b1"`,
    ],
    [...parts.flatMap((part) => ["--b1", ...part]), "--b1--"].join(CRLF)
  );
}

const WITH_ATTACHMENTS = multipart("att-1@mail.example.com", "Lab report", [
  textPart("Report attached."),
  filePart("report.pdf", "application/pdf", PDF_BYTES),
  [
    "Content-Type: image/png",
    "Content-Disposition: inline",
    "Content-ID: <logo@example.com>",
    "Content-Transfer-Encoding: base64",
    "",
    b64(PNG_BYTES),
  ],
]);

const REPLY = mime(
  [
    CF_AUTH_HEADER,
    "From: Jane Doe <jane@example.com>",
    "Subject: Re: Printer is broken",
    "Message-ID: <reply-1@mail.example.com>",
    "In-Reply-To: <ack-1@mail.example.com>",
    "References: <plain-1@mail.example.com> <ack-1@mail.example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ],
  [
    "It's working now, thanks!",
    "",
    "On Mon, Oct 13, 2026 at 9:05 AM Example Co <flow@mail.example.com> wrote:",
    "> Thanks for your email.",
  ].join(CRLF)
);

/** Header block of a raw message, unfolded, as a Headers object. */
function headersOf(raw: string): Headers {
  const block = raw.split(`${CRLF}${CRLF}`, 1)[0]!.replace(/\r\n[ \t]+/g, " ");
  const headers = new Headers();
  for (const line of block.split(CRLF)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

interface FakeMessage {
  message: ForwardableEmailMessage;
  setReject: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  rawReads: () => number;
}

function fakeMessage(raw: string, opts: { from?: string; to?: string; headers?: Record<string, string> } = {}): FakeMessage {
  const headers = headersOf(raw);
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  let reads = 0;
  const setReject = vi.fn();
  const reply = vi.fn();
  const message = {
    from: opts.from ?? SENDER,
    to: opts.to ?? INTAKE_ADDRESS,
    headers,
    rawSize: raw.length,
    // Single-use, like the real stream: a second read is a bug.
    get raw() {
      reads += 1;
      if (reads > 1) throw new Error("raw stream read twice");
      return new Response(raw).body!;
    },
    setReject,
    forward: vi.fn(),
    reply,
  } as unknown as ForwardableEmailMessage;
  return { message, setReject, reply, rawReads: () => reads };
}

const actor = { userId: "us_owner", via: "webhook", apiKeyId: null, automationRuleId: null };

let put: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let checkEmailIntake: ReturnType<typeof vi.fn>;
let ingestEmail: ReturnType<typeof vi.fn>;
let pending: Promise<unknown>[];
let ctx: ExecutionContext;
let logs: string[];
let errors: string[];
let warnings: string[];

function makeEnv(dryRun: string | undefined = "true"): Env {
  return {
    WORKSPACE: {} as Env["WORKSPACE"],
    ATTACHMENTS: { put, delete: remove } as unknown as Env["ATTACHMENTS"],
    SIDE_EFFECTS: {} as Env["SIDE_EFFECTS"],
    ASSETS: {} as Env["ASSETS"],
    SEND_EMAIL: { send } as unknown as SendEmail,
    EMAIL_DRY_RUN: dryRun as string,
    EMAIL_INTAKE_ACK: "true",
    APP_HOSTNAME: "flow.example.com",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
    OWNER_EMAIL: "owner@example.com",
  };
}

const created: IngestEmailResult = { status: "created", taskId: "tk_new", listId: "ls_acme" };

beforeEach(() => {
  put = vi.fn().mockResolvedValue({});
  remove = vi.fn().mockResolvedValue(undefined);
  send = vi.fn().mockResolvedValue({ messageId: "sent-1@example.com" });
  checkEmailIntake = vi.fn().mockResolvedValue({ status: "ok", listId: "ls_acme" });
  ingestEmail = vi.fn().mockResolvedValue(created);
  mocks.workspace.mockReset().mockReturnValue({ checkEmailIntake, ingestEmail });
  mocks.findOwnerActor.mockReset().mockResolvedValue({ user: { id: "us_owner" }, actor });
  pending = [];
  ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  logs = [];
  errors = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(fake: FakeMessage, env: Env = makeEnv()): Promise<void> {
  await handleEmail(fake.message, env, ctx);
  await Promise.all(pending);
}

const ingested = (): IngestEmailInput => ingestEmail.mock.calls[0]![0] as IngestEmailInput;
const jsonLogs = (lines: string[] = logs) =>
  lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
const outcome = () => jsonLogs().find((o) => o.msg === "email intake");

describe("handleEmail — pre-check", () => {
  it.each(["unknown_alias", "sender_not_allowed", "rate_limited"] as const)(
    "rejects %s before reading anything",
    async (status) => {
      checkEmailIntake.mockResolvedValue({ status });
      const fake = fakeMessage(PLAIN);
      await run(fake);
      expect(fake.setReject).toHaveBeenCalledWith(REJECT_REASONS[status]);
      expect(fake.rawReads()).toBe(0);
      expect(put).not.toHaveBeenCalled();
      expect(ingestEmail).not.toHaveBeenCalled();
    }
  );

  it("words the rejects without revealing which aliases exist", () => {
    expect(REJECT_REASONS.unknown_alias).toBe(REJECT_REASONS.sender_not_allowed);
    expect(REJECT_REASONS.sender_not_allowed).toBe("This address only accepts mail from approved senders.");
    expect(REJECT_REASONS.rate_limited).toBe(
      "Too many messages to this address in the last hour; this message was not accepted."
    );
  });

  it("returns quietly on a duplicate and uploads nothing", async () => {
    checkEmailIntake.mockResolvedValue({ status: "duplicate", taskId: "tk_old" });
    const fake = fakeMessage(WITH_ATTACHMENTS);
    await run(fake);
    expect(fake.setReject).not.toHaveBeenCalled();
    expect(fake.rawReads()).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(ingestEmail).not.toHaveBeenCalled();
  });

  it("checks the lowercased alias, envelope sender and normalized Message-ID", async () => {
    await run(fakeMessage(PLAIN));
    expect(checkEmailIntake).toHaveBeenCalledWith({
      alias: "acme",
      sender: "jane@example.com",
      messageId: "plain-1@mail.example.com",
    });
  });

  it("derives a fallback id from stable headers when there is no Message-ID, without reading the stream first", async () => {
    const raw = PLAIN.replace(`Message-ID: <plain-1@mail.example.com>${CRLF}`, "");
    checkEmailIntake.mockResolvedValueOnce({ status: "sender_not_allowed" });
    const refused = fakeMessage(raw);
    await run(refused);
    expect(refused.rawReads()).toBe(0);

    const fake = fakeMessage(raw);
    await run(fake, makeEnv("false"));
    const ids = checkEmailIntake.mock.calls.map((call) => (call[0] as { messageId: string }).messageId);
    expect(ids[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(fake.rawReads()).toBe(1);
    expect(ingested().messageId).toBe(ids[0]);
    // No real id to thread on, so only the RFC 3834 marker is sent.
    expect(send.mock.calls[0]![0].headers).toEqual({ "Auto-Submitted": "auto-replied" });
  });
});

describe("handleEmail — dropped without a trace", () => {
  it.each([
    ["the null sender", { from: "<>" }],
    ["mailer-daemon", { from: "MAILER-DAEMON@mx.example.com" }],
    ["an Auto-Submitted: auto-replied message", { headers: { "Auto-Submitted": "auto-replied" } }],
    ["an out-of-office subject", { headers: { Subject: "Automatic reply: Printer" } }],
  ])("drops %s: no check, no reject, no ticket", async (_label, opts) => {
    const fake = fakeMessage(PLAIN, opts);
    await run(fake);
    expect(checkEmailIntake).not.toHaveBeenCalled();
    expect(fake.setReject).not.toHaveBeenCalled();
    expect(ingestEmail).not.toHaveBeenCalled();
  });
});

describe("handleEmail — new ticket", () => {
  it("builds the ingest input from a plain-text message, as the owner", async () => {
    await run(fakeMessage(PLAIN));
    expect(mocks.findOwnerActor).toHaveBeenCalledOnce();
    expect(ingestEmail).toHaveBeenCalledWith(
      {
        alias: "acme",
        sender: "jane@example.com",
        authenticated: true,
        messageId: "plain-1@mail.example.com",
        referenceIds: [],
        task: {
          title: "Printer is broken",
          description:
            "**From:** Jane Doe <jane@example.com>\n\n" +
            "The front desk printer jams on every page.  \nTried restarting it twice.\n\nThanks,  \nJane",
        },
        commentBody:
          "**Email reply from** Jane Doe <jane@example.com>\n\n" +
          "The front desk printer jams on every page.  \nTried restarting it twice.\n\nThanks,  \nJane",
        attachments: [],
      },
      actor
    );
  });

  it("rethrows (a temporary failure) when there is no owner to act as, before uploading", async () => {
    mocks.findOwnerActor.mockResolvedValue(null);
    await expect(run(fakeMessage(WITH_ATTACHMENTS))).rejects.toThrow("OWNER_EMAIL");
    expect(put).not.toHaveBeenCalled();
    expect(ingestEmail).not.toHaveBeenCalled();
  });

  it("flattens an HTML-only body to text", async () => {
    await run(fakeMessage(HTML_ONLY));
    expect(ingested().task.description).toBe(
      "**From:** Jane Doe <jane@example.com>\n\nThe portal is down.\n\nSince 9am.  \nThanks"
    );
  });

  it("finishes quickly on a multi-megabyte pathological HTML body", async () => {
    const html = '<a href="https://x.example/"><title>'.repeat(60_000) + "<!--".repeat(200_000);
    const raw = HTML_ONLY.replace(/<html>[\s\S]*$/, html);
    expect(raw.length).toBeGreaterThan(2_000_000);
    const start = performance.now();
    await run(fakeMessage(raw));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(ingested().task.description.length).toBeLessThanOrEqual(LIMITS.descriptionMax);
  });

  it("uploads attachments under the email/ namespace, unreferenced inline images included", async () => {
    await run(fakeMessage(WITH_ATTACHMENTS));
    expect(put).toHaveBeenCalledTimes(2);
    const attachments = ingested().attachments;
    expect(attachments.map((a) => [a.filename, a.mimeType, a.size])).toEqual([
      ["report.pdf", "application/pdf", PDF_BYTES.length],
      ["attachment-2.png", "image/png", PNG_BYTES.length],
    ]);
    const [pdfKey, pdfBody, pdfOpts] = put.mock.calls[0]!;
    expect(pdfKey).toMatch(/^email\/[0-9a-f]{16}\/at_[A-Za-z0-9_-]+\/report\.pdf$/);
    expect(pdfKey).toBe(attachments[0]!.r2Key);
    expect(pdfKey).toContain(`/${attachments[0]!.id}/`);
    expect(new TextDecoder().decode(pdfBody as Uint8Array)).toBe(PDF_BYTES);
    expect(pdfOpts.httpMetadata).toEqual({
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    });
    expect(pdfOpts.customMetadata).toEqual({
      attachmentId: attachments[0]!.id,
      source: "email",
      uploadedBy: "us_owner",
    });
    // Same message, same prefix; allowlisted raster images may render inline.
    const [pngKey, , pngOpts] = put.mock.calls[1]!;
    expect(pngKey.split("/")[1]).toBe(pdfKey.split("/")[1]);
    expect(pngOpts.httpMetadata.contentDisposition).toMatch(/^inline; /);
  });

  it("drops small cid:-referenced inline images but keeps large ones", async () => {
    const photo = "J".repeat(20_000);
    const related = multipart(
      "sig-1@mail.example.com",
      "With signature",
      [
        [
          "Content-Type: text/html; charset=utf-8",
          "",
          '<p>See photo</p><img src="cid:photo@example.com"><img src="cid:logo@example.com">',
        ],
        ["Content-Type: image/png", "Content-ID: <logo@example.com>", "Content-Transfer-Encoding: base64", "", b64(PNG_BYTES)],
        [
          "Content-Type: image/jpeg",
          "Content-ID: <photo@example.com>",
          'Content-Disposition: inline; filename="photo.jpg"',
          "Content-Transfer-Encoding: base64",
          "",
          b64(photo),
        ],
      ],
      "related"
    );
    await run(fakeMessage(related));
    expect(ingested().attachments.map((a) => [a.filename, a.size])).toEqual([["photo.jpg", photo.length]]);
    expect(outcome()).toMatchObject({ attachments: 1, inlineImagesDropped: 1, skippedAttachments: 0 });
  });

  it(`keeps at most ${MAX_ATTACHMENTS} attachments, uploads a few at a time, and notes the rest`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    put.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return {};
    });
    const parts = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) =>
      filePart(`scan-${i + 1}.pdf`, "application/pdf", `${PDF_BYTES}${i}`)
    );
    await run(fakeMessage(multipart("many-1@mail.example.com", "Scans", [textPart("All scans."), ...parts])));
    expect(put).toHaveBeenCalledTimes(MAX_ATTACHMENTS);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    const input = ingested();
    expect(input.attachments.map((a) => a.filename).at(-1)).toBe(`scan-${MAX_ATTACHMENTS}.pdf`);
    expect(input.task.description).toContain("_3 more attachments were not saved: at most 20 are kept per email._");
    expect(input.commentBody).toContain("_3 more attachments were not saved");
  });

  it("sends a generic ack with threading headers when live", async () => {
    await run(fakeMessage(PLAIN), makeEnv("false"));
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]![0];
    expect(sent).toMatchObject({
      from: DEFAULT_EMAIL_FROM,
      to: "jane@example.com",
      replyTo: INTAKE_ADDRESS,
      subject: ACK_SUBJECT,
      headers: {
        "In-Reply-To": "<plain-1@mail.example.com>",
        References: "<plain-1@mail.example.com>",
        "Auto-Submitted": "auto-replied",
      },
    });
    expect(sent.text).toContain("opened a ticket.");
    expect(sent.text).toContain("reply to this email");
    // Nothing the sender wrote goes back out.
    expect(`${sent.subject}${sent.text}${sent.html}`).not.toMatch(/printer/i);
    // Clients can't sign in, so the ack never links to Flow.
    expect(sent.html).toContain("Sent via Flow");
    expect(`${sent.text}${sent.html}`).not.toContain("flow.example.com");
  });

  it("never reflects a subject carrying a link", async () => {
    const raw = PLAIN.replace("Subject: Re: FW:  Printer   is broken", "Subject: Reset at https://evil.example/x");
    await run(fakeMessage(raw), makeEnv("false"));
    const sent = send.mock.calls[0]![0];
    expect(JSON.stringify(sent)).not.toContain("evil.example");
  });

  it("carries the original References ahead of its Message-ID", async () => {
    const raw = PLAIN.replace(
      "MIME-Version",
      `References: <root@example.com> <mid@example.com>${CRLF}In-Reply-To: <mid@example.com>${CRLF}MIME-Version`
    );
    await run(fakeMessage(raw), makeEnv("false"));
    expect(send.mock.calls[0]![0].headers.References).toBe(
      "<root@example.com> <mid@example.com> <plain-1@mail.example.com>"
    );
  });

  it("caps referenceIds, keeping In-Reply-To and the thread root", async () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<r${i}@example.com>`).join(" ");
    const raw = PLAIN.replace(
      "MIME-Version",
      `References: ${refs}${CRLF}In-Reply-To: <r29@example.com>${CRLF}MIME-Version`
    );
    await run(fakeMessage(raw));
    const ids = ingested().referenceIds;
    expect(ids).toHaveLength(MAX_REFERENCE_IDS);
    expect(ids.slice(0, 2)).toEqual(["r29@example.com", "r0@example.com"]);
  });

  it("only logs the ack in dry run", async () => {
    await run(fakeMessage(PLAIN), makeEnv("true"));
    expect(send).not.toHaveBeenCalled();
    const dry = logs.find((line) => line.startsWith("[EMAIL_DRY_RUN]"));
    expect(dry).toContain("to:       jane@example.com");
    expect(dry).toContain(`reply-to: ${INTAKE_ADDRESS}`);
  });

  it("treats an unset EMAIL_DRY_RUN as dry run", async () => {
    await run(fakeMessage(PLAIN), makeEnv(undefined));
    expect(send).not.toHaveBeenCalled();
  });

  it("never acknowledges automated mail, even when live", async () => {
    await run(fakeMessage(PLAIN, { headers: { Precedence: "bulk" } }), makeEnv("false"));
    expect(ingestEmail).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(logs.some((line) => line.startsWith("[EMAIL_DRY_RUN]"))).toBe(false);
  });

  it("sends no ack at all until EMAIL_INTAKE_ACK is on", async () => {
    for (const flag of [undefined, "false"]) {
      send.mockClear();
      await run(fakeMessage(PLAIN), { ...makeEnv("false"), EMAIL_INTAKE_ACK: flag });
      expect(send).not.toHaveBeenCalled();
    }
    expect(logs.some((line) => line.startsWith("[EMAIL_DRY_RUN]"))).toBe(false);
  });

  it("logs structured outcomes without bodies, keys or filenames", async () => {
    await run(fakeMessage(WITH_ATTACHMENTS));
    expect(outcome()).toMatchObject({
      alias: "acme",
      status: "created",
      taskId: "tk_new",
      authenticated: true,
      attachments: 2,
      attachmentIds: ingested().attachments.map((a) => a.id),
    });
    const all = [...logs, ...errors, ...warnings].filter((l) => l.startsWith("{")).join("\n");
    expect(all).not.toContain("Report attached");
    expect(all).not.toContain("report.pdf");
    expect(all).not.toContain("email/");
  });
});

describe("handleEmail — authentication", () => {
  it("logs one compact auth line per message: domains and tokens, no local parts", async () => {
    await run(fakeMessage(PLAIN));
    const lines = jsonLogs().filter((o) => o.msg === "email intake auth");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      alias: "acme",
      authenticated: true,
      via: "dmarc",
      authHeaders: [{ h: "arc-authentication-results", pos: 0, i: 1, authserv: "mx.cloudflare.net", cf: true }],
      inHeadersObject: ["arc-authentication-results"],
    });
    expect(JSON.stringify(lines[0])).not.toContain("jane@");
    expect(JSON.stringify(lines[0])).not.toContain("printer");
  });

  it("files unauthenticated mail as unverified, marked, and never acknowledged", async () => {
    await run(fakeMessage(unauthenticated(PLAIN)), makeEnv("false"));
    const input = ingested();
    expect(input.authenticated).toBe(false);
    expect(input.task.description.startsWith(`${UNVERIFIED_NOTE}\n\n**From:** Jane Doe <jane@example.com>`)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(outcome()).toMatchObject({ status: "created", authenticated: false, acknowledge: false });
    expect(jsonLogs().find((o) => o.msg === "email intake auth")).toMatchObject({
      authenticated: false,
      authHeaders: [],
      authHeaderCount: 0,
    });
  });

  it("does not trust a results header a forger put below Cloudflare's", async () => {
    const raw = PLAIN.replace(
      `${CF_AUTH_HEADER}${CRLF}`,
      [
        "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=attacker.example; spf=permerror smtp.mailfrom=jane@example.com",
        "Received: from mail.attacker.example by mx.cloudflare.net",
        "ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass header.from=example.com",
        "Authentication-Results: mx.attacker.example; dmarc=pass header.from=example.com",
        "",
      ].join(CRLF)
    );
    await run(fakeMessage(raw), makeEnv("false"));
    expect(ingested().authenticated).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("marks an unauthenticated reply's comment", async () => {
    ingestEmail.mockResolvedValue({ status: "commented", taskId: "tk_new", commentId: "cm_1", listId: "ls_acme" });
    await run(fakeMessage(unauthenticated(REPLY)));
    expect(ingested().commentBody).toBe(
      `${UNVERIFIED_NOTE}\n\n**Email reply from** Jane Doe <jane@example.com>\n\nIt's working now, thanks!`
    );
  });
});

describe("handleEmail — acknowledgement failures", () => {
  it("retries once without custom headers when the binding refuses them", async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error("header not allowed"), { code: "E_HEADER_NOT_ALLOWED" }))
      .mockResolvedValueOnce({ messageId: "sent-2@example.com" });
    await run(fakeMessage(PLAIN), makeEnv("false"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].headers).toBeUndefined();
    expect(send.mock.calls[1]![0].replyTo).toBe(INTAKE_ADDRESS);
    expect(warnings.join("\n")).toContain("threading headers were refused");
    expect(errors).toEqual([]);
  });

  it("logs any other send failure and still completes the ingest", async () => {
    send.mockRejectedValue(Object.assign(new Error("no DMARC"), { code: "E_DELIVERY_FAILED" }));
    const fake = fakeMessage(PLAIN);
    await expect(run(fake, makeEnv("false"))).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(fake.setReject).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("email intake ack failed");
  });

  it("logs a missing SEND_EMAIL binding instead of failing", async () => {
    const env = { ...makeEnv("false"), SEND_EMAIL: undefined };
    await expect(run(fakeMessage(PLAIN), env)).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("SEND_EMAIL binding is missing");
  });
});

describe("handleEmail — replies and refusals at ingest", () => {
  it("passes threading ids and a quote-stripped comment, and sends no ack", async () => {
    ingestEmail.mockResolvedValue({ status: "commented", taskId: "tk_new", commentId: "cm_1", listId: "ls_acme" });
    await run(fakeMessage(REPLY), makeEnv("false"));
    const input = ingested();
    expect(input.referenceIds).toEqual(["ack-1@mail.example.com", "plain-1@mail.example.com"]);
    expect(input.commentBody).toBe("**Email reply from** Jane Doe <jane@example.com>\n\nIt's working now, thanks!");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["sender_not_allowed", REJECT_REASONS.sender_not_allowed],
    ["unknown_alias", REJECT_REASONS.unknown_alias],
    ["rate_limited", REJECT_REASONS.rate_limited],
    ["duplicate", null],
  ] as const)("deletes the uploads when ingest says %s", async (status, reason) => {
    ingestEmail.mockResolvedValue(status === "duplicate" ? { status, taskId: "tk_old" } : { status });
    const fake = fakeMessage(WITH_ATTACHMENTS);
    await run(fake, makeEnv("false"));
    const keys = put.mock.calls.map((call) => call[0]);
    expect(keys).toHaveLength(2);
    expect(remove).toHaveBeenCalledWith(keys);
    if (reason === null) expect(fake.setReject).not.toHaveBeenCalled();
    else expect(fake.setReject).toHaveBeenCalledWith(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the uploads and returns quietly when ingest threw after its turn committed", async () => {
    ingestEmail.mockRejectedValue(new Error("Network connection lost."));
    checkEmailIntake
      .mockResolvedValueOnce({ status: "ok", listId: "ls_acme" })
      .mockResolvedValueOnce({ status: "duplicate", taskId: "tk_filed" });
    const fake = fakeMessage(WITH_ATTACHMENTS);
    await expect(run(fake, makeEnv("false"))).resolves.toBeUndefined();
    expect(checkEmailIntake).toHaveBeenCalledTimes(2);
    expect(checkEmailIntake.mock.calls[1]![0]).toEqual(checkEmailIntake.mock.calls[0]![0]);
    expect(remove).not.toHaveBeenCalled();
    expect(fake.setReject).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(outcome()).toMatchObject({ status: "duplicate", stage: "ingest_error", taskId: "tk_filed" });
  });

  it("deletes the uploads and rethrows when ingest threw and nothing was filed, so the sender retries", async () => {
    const boom = new Error("Durable Object reset");
    ingestEmail.mockRejectedValue(boom);
    const fake = fakeMessage(WITH_ATTACHMENTS);
    await expect(run(fake)).rejects.toBe(boom);
    expect(checkEmailIntake).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(put.mock.calls.map((call) => call[0]));
    expect(fake.setReject).not.toHaveBeenCalled();
  });

  it("keeps the uploads and rethrows when it can't tell whether ingest committed", async () => {
    const boom = new Error("Network connection lost.");
    ingestEmail.mockRejectedValue(boom);
    checkEmailIntake
      .mockResolvedValueOnce({ status: "ok", listId: "ls_acme" })
      .mockRejectedValueOnce(new Error("Network connection lost."));
    await expect(run(fakeMessage(WITH_ATTACHMENTS))).rejects.toBe(boom);
    expect(remove).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("outcome is unknown");
    expect(errors.join("\n")).not.toContain("report.pdf");
  });

  it.each([
    ["a plain error", new Error(`${EMAIL_INGEST_PERMANENT_ERROR}: Space sp_x is private; ask an owner/admin for access.`)],
    ["the DO proxy's wrapped error", new ApiError(422, `${EMAIL_INGEST_PERMANENT_ERROR}: Attachment id at_x is already in use.`)],
  ])("rejects a permanent refusal (%s) instead of asking for a retry", async (_label, err) => {
    ingestEmail.mockRejectedValue(err);
    const fake = fakeMessage(WITH_ATTACHMENTS);
    await expect(run(fake, makeEnv("false"))).resolves.toBeUndefined();
    expect(fake.setReject).toHaveBeenCalledWith(PERMANENT_REJECT);
    expect(remove).toHaveBeenCalledWith(put.mock.calls.map((call) => call[0]));
    expect(checkEmailIntake).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(outcome()).toMatchObject({ status: "rejected", stage: "ingest" });
  });

  it("cleans up and rethrows when an upload fails, starting no new uploads", async () => {
    put.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("R2 503"));
    const parts = Array.from({ length: 10 }, (_, i) => filePart(`f${i}.pdf`, "application/pdf", `${PDF_BYTES}${i}`));
    await expect(run(fakeMessage(multipart("up-1@mail.example.com", "Files", parts)))).rejects.toThrow("R2 503");
    // Four lanes start at once; once the failure lands, no lane picks up more.
    expect(put.mock.calls.length).toBeLessThan(10);
    expect(remove).toHaveBeenCalledWith(put.mock.calls.map((call) => call[0]));
    expect(ingestEmail).not.toHaveBeenCalled();
  });
});

describe("deleteUploads", () => {
  it("deletes in batches R2 accepts and logs ids, never keys", async () => {
    remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("R2 500")).mockResolvedValueOnce(undefined);
    const uploads = Array.from({ length: 2500 }, (_, i) => ({
      id: `at_${i}`,
      r2Key: `email/abc/at_${i}/private-name-${i}.pdf`,
    }));
    await deleteUploads(makeEnv(), uploads);
    expect(remove.mock.calls.map((call) => (call[0] as string[]).length)).toEqual([1000, 1000, 500]);
    const logged = errors.join("\n");
    expect(logged).toContain("at_1000");
    expect(logged).not.toContain("private-name-");
    expect(logged).not.toContain("email/");
  });
});
