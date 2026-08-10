export async function onRequestPost(context) {
  const auth = await authenticatedUser(context);
  if (!auth) return json({ error: "unauthorized" }, 401);
  const { username } = auth;

  try {
    const body = await context.request.json();
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 250) : [];
    const cursor = Math.max(0, Number(body.cursor) || 0);

    for (const change of changes) {
      if (!change?.entry?.id || !change.entry.updatedAt) continue;
      await applyChange(context.env.DB, change.entry, username);
    }

    const remote = await context.env.DB.prepare(
      "SELECT e.data_json, l.id AS cursor FROM sync_log l JOIN entries e ON e.id = l.entry_id WHERE l.id > ? ORDER BY l.id ASC LIMIT 500"
    ).bind(cursor).all();
    const entries = [];
    let nextCursor = cursor;
    for (const row of remote.results || []) {
      entries.push(JSON.parse(row.data_json));
      nextCursor = Math.max(nextCursor, Number(row.cursor));
    }
    const expires = new Date(Date.now() + 365 * 86400000).toISOString();
    await context.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
      .bind(expires, auth.tokenHash).run();
    return json({ entries, cursor: nextCursor }, 200, { "Set-Cookie": sessionCookie(context.request, auth.token) });
  } catch (error) {
    return json({ error: "sync_failed", message: error.message }, 500);
  }
}

async function applyChange(db, incoming, username) {
  const existingRow = await db.prepare("SELECT data_json, version FROM entries WHERE id = ?").bind(incoming.id).first();
  const entry = { ...incoming, updatedBy: username, syncStatus: "synced" };

  if (existingRow) {
    const existing = JSON.parse(existingRow.data_json);
    const incomingUpdatedAt = new Date(incoming.updatedAt).getTime();
    const existingUpdatedAt = new Date(existing.updatedAt).getTime();
    if (Number.isFinite(existingUpdatedAt) && incomingUpdatedAt <= existingUpdatedAt) return;
    entry.version = Math.max(Number(incoming.version || 1), Number(existingRow.version || 1) + 1);
  }

  await db.batch([
    db.prepare("INSERT INTO entries (id, type, occurred_at, data_json, created_by, updated_at, updated_by, version, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, occurred_at = excluded.occurred_at, data_json = excluded.data_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = excluded.version, deleted = excluded.deleted")
      .bind(entry.id, entry.type, entry.occurredAt, JSON.stringify(entry), entry.createdBy || username, entry.updatedAt, username, Number(entry.version || 1), entry.deleted ? 1 : 0),
    db.prepare("INSERT INTO sync_log (entry_id, changed_at) VALUES (?, ?)").bind(entry.id, new Date().toISOString()),
  ]);
}

async function authenticatedUser(context) {
  const authorization = context.request.headers.get("Authorization") || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookie = context.request.headers.get("Cookie") || "";
  const prefix = "hynhi_session=";
  const token = bearerToken || cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const session = await context.env.DB.prepare("SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, new Date().toISOString()).first();
  return session?.username ? { username: session.username, token, tokenHash } : null;
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `hynhi_session=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=31536000`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}
