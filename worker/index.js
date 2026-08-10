import { onRequestPost as login } from "../functions/api/login.js";
import { onRequestPost as logout } from "../functions/api/logout.js";
import { onRequestPost as sync } from "../functions/api/sync.js";

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://inan03091991-pixel.github.io",
  "https://hy-nhi-care.tonynguyen2409.chatgpt.site",
]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = getAllowedOrigins(env);
    if (request.method === "OPTIONS") return preflight(origin, allowedOrigins);

    const url = new URL(request.url);
    let response;
    if (request.method === "POST" && url.pathname === "/api/login") response = await login({ request, env });
    else if (request.method === "POST" && url.pathname === "/api/logout") response = await logout({ request, env });
    else if (request.method === "POST" && url.pathname === "/api/sync") response = await sync({ request, env });
    else if (request.method === "GET" && url.pathname === "/api/health") response = json({ ok: true });
    else response = json({ error: "not_found" }, 404);

    return withCors(response, origin, allowedOrigins);
  },
};

function getAllowedOrigins(env) {
  const configuredOrigins = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
}

function preflight(origin, allowedOrigins) {
  if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}

function withCors(response, origin, allowedOrigins) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
