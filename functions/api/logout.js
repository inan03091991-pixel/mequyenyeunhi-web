
export async function onRequestPost(context) {
  const authorization = context.request.headers.get("Authorization") || "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookie = context.request.headers.get("Cookie") || "";
  const prefix = "hynhi_session=";
  const token = bearerToken || cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (token) {
    const tokenHash = await sha256(token);
    await context.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  const secure = new URL(context.request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `hynhi_session=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`,
    },
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
