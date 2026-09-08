import process from "node:process";
import { Resolver } from "node:dns/promises";

/**
 * Deliverability preflight for the sending domain.
 *
 * This exists because the failure it catches has no other symptom. A missing
 * record does not break a deploy, does not fail a smoke test, and does not
 * show up in `wrangler tail`: Resend accepts the message, returns an id, and
 * the receiver quietly files it somewhere the recipient never looks. The gap
 * only surfaces weeks later as "some people never get the sign-in mail".
 *
 * It checks more than Resend's own dashboard does, because Resend verifies
 * only the records it asked for. The two it never mentions - an SPF policy on
 * the From domain itself, and that From domain existing at all in DNS - are
 * both things Microsoft looks at and Gmail does not, which is exactly the
 * shape of a "works for Gmail, unreliable for Outlook" report.
 *
 * Usage:
 *   node scripts/mailcheck.mjs [from-domain] [--dkim resend] [--json]
 *
 * Defaults to the domain in wrangler.jsonc's EMAIL_FROM.
 */

const DEFAULT_DOMAIN = "send.rabblebabble.cc";
const DEFAULT_DKIM_SELECTOR = "resend";
// Public resolvers, so a corporate or ISP resolver's split horizon cannot make
// a missing public record look present.
const NAMESERVERS = ["1.1.1.1", "8.8.8.8"];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const domain = process.argv[2]?.startsWith("--") ? DEFAULT_DOMAIN : (process.argv[2] ?? DEFAULT_DOMAIN);
const selector = argument("dkim", DEFAULT_DKIM_SELECTOR);
const asJson = process.argv.includes("--json");

const resolver = new Resolver();
resolver.setServers(NAMESERVERS);

/** Every lookup here treats "no such record" as data, never as an error. */
async function lookup(kind, name) {
  try {
    if (kind === "TXT") {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    }
    if (kind === "MX") {
      return (await resolver.resolveMx(name)).map((record) => `${record.priority} ${record.exchange}`);
    }
    return await resolver.resolve4(name);
  } catch {
    return [];
  }
}

/**
 * The organizational domain, for DMARC's relaxed alignment and for the policy
 * a subdomain inherits. Good enough for the domains this repo sends from; it
 * is not a public-suffix-list implementation.
 */
function organizationalDomain(name) {
  const labels = name.split(".");
  return labels.length <= 2 ? name : labels.slice(-2).join(".");
}

const results = [];

function record(level, name, detail, fix = null) {
  results.push({ level, name, detail, fix });
}

async function run() {
  const root = organizationalDomain(domain);

  // 1. DKIM. Resend signs with d=<domain>, so this one aligns by construction.
  const dkim = (await lookup("TXT", `${selector}._domainkey.${domain}`)).filter((value) => value.includes("p="));
  if (dkim.length === 0) {
    record("fail", "DKIM", `no key at ${selector}._domainkey.${domain}`, "Re-add the DKIM record Resend shows, as DNS-only.");
  } else {
    record("ok", "DKIM", `${selector}._domainkey.${domain} publishes a key`);
  }

  // 2. The custom MAIL FROM subdomain. This is what carries SPF for the
  //    envelope sender, and what bounces are routed back to.
  const bounceDomain = `send.${domain}`;
  const bounceMx = await lookup("MX", bounceDomain);
  const bounceSpf = (await lookup("TXT", bounceDomain)).filter((value) => value.startsWith("v=spf1"));
  if (bounceMx.length === 0 || bounceSpf.length === 0) {
    record(
      "warn",
      "Return-Path",
      `${bounceDomain} has ${bounceMx.length} MX and ${bounceSpf.length} SPF record(s)`,
      "Without both, Resend falls back to its shared bounce domain and SPF stops aligning with the From domain.",
    );
  } else {
    record("ok", "Return-Path", `${bounceDomain} carries the MAIL FROM MX and SPF`);
  }

  // 3. The From domain has to exist in DNS. An empty non-terminal - a name
  //    with children but no records of its own - resolves to NOERROR/NODATA,
  //    which is not the same as existing. Gmail does not care. Microsoft's
  //    filters treat a From domain with no MX and no A as not a mail domain.
  const fromMx = await lookup("MX", domain);
  const fromA = await lookup("A", domain);
  if (fromMx.length === 0 && fromA.length === 0) {
    record(
      "fail",
      "From domain resolves",
      `${domain} has no MX and no A record of its own`,
      `Publish a null MX on ${domain}: MX priority 0, target "." (RFC 7505). It declares the domain send-only, which is true, and gives Microsoft something to resolve.`,
    );
  } else {
    record("ok", "From domain resolves", `${domain} answers with ${fromMx.length} MX / ${fromA.length} A`);
  }

  // 4. SPF on the From domain itself. Classic SPF checks the envelope sender,
  //    so this is not what makes SPF pass - but Microsoft's filters weigh the
  //    header From domain's own DNS presence, where "no record at all" is a
  //    worse answer than a restrictive one.
  const fromSpf = (await lookup("TXT", domain)).filter((value) => value.startsWith("v=spf1"));
  if (fromSpf.length === 0) {
    record(
      "warn",
      "SPF on the From domain",
      `${domain} publishes no SPF record`,
      // ~all, not -all, and deliberately: nothing ever uses this domain as an
      // envelope sender, so a hard fail buys no alignment DKIM does not
      // already provide - and it would reject real mail the day Resend sends
      // from an IP outside the amazonses.com include. Matches the record
      // Resend generated on send.send for the same reason.
      `Add TXT ${domain} = "v=spf1 include:amazonses.com ~all".`,
    );
  } else if (fromSpf.length > 1) {
    record("fail", "SPF on the From domain", `${domain} publishes ${fromSpf.length} SPF records; more than one is a permerror`);
  } else {
    record("ok", "SPF on the From domain", fromSpf[0]);
  }

  // 5. DMARC, on the sending subdomain if it has its own, otherwise inherited.
  const ownDmarc = (await lookup("TXT", `_dmarc.${domain}`)).filter((value) => value.startsWith("v=DMARC1"));
  const rootDmarc = (await lookup("TXT", `_dmarc.${root}`)).filter((value) => value.startsWith("v=DMARC1"));
  const dmarc = ownDmarc[0] ?? rootDmarc[0] ?? null;
  if (dmarc === null) {
    record("fail", "DMARC", `no policy at _dmarc.${domain} or _dmarc.${root}`);
  } else {
    const inherited = ownDmarc.length === 0;
    const policy = /\bsp=([a-z]+)/.exec(dmarc)?.[1] ?? /\bp=([a-z]+)/.exec(dmarc)?.[1] ?? "none";
    const where = inherited ? `inherited from ${root}` : `own record on ${domain}`;
    if (policy === "none") {
      record(
        "warn",
        "DMARC",
        `${where}, effective policy p=none`,
        "p=none is the floor, not a pass. Move to p=quarantine once reports are clean; Microsoft treats an enforcing policy noticeably better than a monitoring one.",
      );
    } else {
      record("ok", "DMARC", `${where}, effective policy p=${policy}`);
    }
  }

  // 6. The rua mailbox has to be able to receive. A report address on a domain
  //    with no MX is the reason a deliverability problem can run for weeks
  //    with nothing to look at.
  const rua = dmarc === null ? null : /\brua=mailto:([^;,\s]+)/.exec(dmarc)?.[1];
  if (rua) {
    const ruaDomain = rua.split("@")[1] ?? "";
    const ruaMx = await lookup("MX", ruaDomain);
    if (ruaMx.length === 0) {
      record(
        "fail",
        "DMARC reports are deliverable",
        `rua points at ${ruaDomain}, which has no MX record`,
        "Aggregate reports are being sent and dropped. Point rua at a mailbox that exists, or at a DMARC reporting service.",
      );
    } else {
      record("ok", "DMARC reports are deliverable", `${ruaDomain} accepts mail`);
    }
  } else if (dmarc !== null) {
    record("warn", "DMARC reports", "the policy requests no aggregate reports (no rua=)");
  }

  report();
}

function report() {
  if (asJson) {
    console.log(JSON.stringify({ domain, selector, results }, null, 2));
  } else {
    console.log(`Mail deliverability preflight for ${domain}\n`);
    for (const { level, name, detail, fix } of results) {
      const mark = level === "ok" ? "ok  " : level === "warn" ? "warn" : "FAIL";
      console.log(`  ${mark}  ${name} - ${detail}`);
      if (fix && level !== "ok") {
        console.log(`        ${fix}`);
      }
    }
    console.log("");
  }

  const failures = results.filter((entry) => entry.level === "fail").length;
  const warnings = results.filter((entry) => entry.level === "warn").length;
  if (failures > 0) {
    console.error(`${failures} check(s) failed, ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`All checks passed${warnings > 0 ? `, with ${warnings} warning(s)` : ""}.`);
}

await run();
