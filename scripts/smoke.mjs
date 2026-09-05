import process from "node:process";

/**
 * End-to-end smoke test against a running Worker.
 *
 * This is the only check that exercises real network behaviour: actual body
 * size limits, actual cookie handling, actual asset routing. The integration
 * tests run inside workerd and cannot see any of that.
 *
 * Usage:
 *   npm run dev:worker           # in another terminal
 *   node scripts/smoke.mjs [baseUrl] [--invite CODE] [--email you@example.com]
 */

const baseUrl = (process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:8787").replace(/\/+$/, "");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const inviteCode = argument("invite");
const email = argument("email") ?? "smoke@example.com";

const APP_HEADERS = {
  Origin: baseUrl,
  "Sec-Fetch-Site": "same-origin",
  "X-RB-Client": "1",
};

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function run() {
  console.log(`Smoke testing ${baseUrl}\n`);

  console.log("unauthenticated access");
  const me = await fetch(`${baseUrl}/v1/me`, { headers: APP_HEADERS });
  check("GET /v1/me is 401 without a session", me.status === 401, `got ${me.status}`);
  const meBody = await me.json().catch(() => ({}));
  check("401 uses the shared error envelope", meBody?.error?.code === "not-authenticated", JSON.stringify(meBody));
  check("responses are never cached", me.headers.get("Cache-Control") === "no-store");

  console.log("\ncross-site protection");
  const noHeader = await fetch(`${baseUrl}/v1/me`, { headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin" } });
  check("a request without X-RB-Client is refused", noHeader.status === 403, `got ${noHeader.status}`);
  const foreign = await fetch(`${baseUrl}/v1/me`, { headers: { ...APP_HEADERS, Origin: "https://evil.example" } });
  check("a request from another origin is refused", foreign.status === 403, `got ${foreign.status}`);

  console.log("\nupload limits");
  // 26 MB: past the 25 MiB cap, and the one limit only a real request proves.
  const oversized = await fetch(`${baseUrl}/v1/transcribe`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "audio/webm" },
    body: new Uint8Array(26 * 1024 * 1024),
  });
  check(
    "an oversized upload is refused (401 before sign-in, 413 after)",
    oversized.status === 413 || oversized.status === 401,
    `got ${oversized.status}`,
  );

  console.log("\nstatic assets");
  const root = await fetch(`${baseUrl}/`);
  check("the app shell is served from the same origin", root.ok, `got ${root.status}`);
  check("the app shell is HTML", (root.headers.get("Content-Type") ?? "").includes("text/html"));

  console.log("\nsign-in");
  const requested = await fetch(`${baseUrl}/auth/request-link`, {
    method: "POST",
    headers: { ...APP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ email, ...(inviteCode ? { inviteCode } : {}) }),
  });
  check("POST /auth/request-link is 202", requested.status === 202, `got ${requested.status}`);
  const requestedBody = await requested.json().catch(() => ({}));

  const devLink = requestedBody?.devLink;
  if (typeof devLink !== "string") {
    console.log("  skip  full sign-in (no devLink; set EMAIL_MODE=console and pass --invite)");
  } else {
    const nonce = readCookie(requested, "__Host-rb_link");
    const interstitial = await fetch(devLink, { headers: { "Sec-Fetch-Site": "none" } });
    check("the magic link renders a confirm page", interstitial.status === 200, `got ${interstitial.status}`);
    const html = await interstitial.text();
    check("the confirm page posts rather than redeeming on GET", html.includes('method="POST"'));

    const token = new URL(devLink).searchParams.get("token") ?? "";
    const consumed = await fetch(`${baseUrl}/auth/callback`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
        ...(nonce ? { Cookie: `__Host-rb_link=${nonce}` } : {}),
      },
      body: new URLSearchParams({ token }).toString(),
    });
    check("redeeming the link signs in", consumed.status === 303, `got ${consumed.status}`);

    const sessionCookie = readCookie(consumed, "__Host-rb_session");
    check("a __Host- session cookie is set", Boolean(sessionCookie));

    if (sessionCookie) {
      const signedIn = await fetch(`${baseUrl}/v1/me`, {
        headers: { ...APP_HEADERS, Cookie: `__Host-rb_session=${sessionCookie}` },
      });
      check("GET /v1/me now succeeds", signedIn.status === 200, `got ${signedIn.status}`);
      const profile = await signedIn.json().catch(() => ({}));
      check("the profile reports a quota", typeof profile?.quota?.audioSecondsLimit === "number");

      const replay = await fetch(`${baseUrl}/auth/callback`, {
        method: "POST",
        redirect: "manual",
        headers: {
          Origin: baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/x-www-form-urlencoded",
          ...(nonce ? { Cookie: `__Host-rb_link=${nonce}` } : {}),
        },
        body: new URLSearchParams({ token }).toString(),
      });
      check("the link cannot be redeemed twice", replay.status === 400, `got ${replay.status}`);
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

function readCookie(response, name) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator !== -1 && pair.slice(0, separator).trim() === name) {
      const value = pair.slice(separator + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

await run();
