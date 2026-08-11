const USER_VERIFIERS = {
  mequyen: { salt: "kP3ABO5WahkvRQYbnuw4ug==", hash: "GNWNPBlkAKZPuBeiVKnCZWdmYU6mzhQEq+TS2S/t9OA=" },
  bonghia: { salt: "W70pPl8HVQctTtpcbJBfoQ==", hash: "wCQtoMySSNVkLP49UuX+J03IjLZvMYL3mTLcgNIjc7s=" },
};

const PROFILE = {
  name: "Nguyễn Diên Hỷ Nhi",
  shortName: "Hỷ Nhi",
  sex: "Nữ",
  birthAt: "2026-05-25T15:03:00+07:00",
  birthPlace: "Bệnh viện Phụ sản Trung ương, Hà Nội",
  timezone: "Asia/Ho_Chi_Minh",
};

const MAX_ATTEMPTS = 5;
const WINDOW_MILLISECONDS = 15 * 60 * 1000;
const SESSION_MILLISECONDS = 365 * 86400000;
const SESSION_MAX_AGE = 31536000;

export async function onRequestPost(context) {
  try {
    const { username: rawUsername, password } = await context.request.json();
    const username = String(rawUsername || "").trim().toLowerCase();
    const attemptKey = await loginAttemptKey(context.request, username);
    const now = new Date();
    const attempt = await context.env.DB.prepare("SELECT failures, window_started, locked_until FROM login_attempts WHERE attempt_key = ?")
      .bind(attemptKey).first();
    if (attempt?.locked_until && new Date(attempt.locked_until) > now) return json({ error: "rate_limited" }, 429);

    const verifier = USER_VERIFIERS[username];
    if (!verifier || !(await verify(password, verifier))) {
      await recordFailedAttempt(context.env.DB, attemptKey, attempt, now);
      return json({ error: "invalid_credentials" }, 401);
    }

    await context.env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(attemptKey).run();

    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = toBase64Url(tokenBytes);
    const tokenHash = await sha256(token);
    const expires = new Date(now.getTime() + SESSION_MILLISECONDS);
    await context.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()).run();
    await context.env.DB.prepare("INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(tokenHash, username, now.toISOString(), expires.toISOString()).run();

    const secure = new URL(context.request.url).protocol === "https:" ? "; Secure" : "";
    return new Response(JSON.stringify({ ok: true, username, profile: PROFILE, token }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": `hynhi_session=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "login_error",
      message: error instanceof Error ? error.message : "unknown_error",
    }));
    return json({ error: "bad_request" }, 400);
  }
}

async function recordFailedAttempt(db, attemptKey, previous, now) {
  const previousStarted = previous?.window_started ? new Date(previous.window_started) : null;
  const withinWindow = previousStarted && now - previousStarted < WINDOW_MILLISECONDS;
  const failures = withinWindow ? Number(previous.failures || 0) + 1 : 1;
  const windowStarted = withinWindow ? previous.window_started : now.toISOString();
  const lockedUntil = failures >= MAX_ATTEMPTS ? new Date(now.getTime() + WINDOW_MILLISECONDS).toISOString() : null;
  await db.prepare("INSERT INTO login_attempts (attempt_key, failures, window_started, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, window_started = excluded.window_started, locked_until = excluded.locked_until")
    .bind(attemptKey, failures, windowStarted, lockedUntil).run();
}

async function loginAttemptKey(request, username) {
  const address = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  return sha256(`${username || "unknown"}:${address}`);
}

async function verify(password, verifier) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password || "")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromBase64(verifier.salt), iterations: 100000, hash: "SHA-256" }, key, 256));
  const expected = fromBase64(verifier.hash);
  if (bits.length !== expected.length) return false;
  let result = 0;
  for (let index = 0; index < bits.length; index += 1) result |= bits[index] ^ expected[index];
  return result === 0;
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
