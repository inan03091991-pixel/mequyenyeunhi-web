const APP_ORIGIN = "https://inan03091991-pixel.github.io";
const UPSTREAM_ORIGIN = "https://hy-nhi-care.tonynguyen2409.chatgpt.site";
const ALLOWED_ROUTES = new Map([
  ["/api/login", new Set(["POST"])],
  ["/api/logout", new Set(["POST"])],
  ["/api/sync", new Set(["POST"])],
  ["/api/health", new Set(["GET"])],
]);

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return preflight(origin, url.pathname);
    }

    const methods = ALLOWED_ROUTES.get(url.pathname);
    if (!methods || !methods.has(request.method)) {
      return json({ error: "not_found" }, 404, origin);
    }

    if (origin && origin !== APP_ORIGIN) {
      return json({ error: "origin_not_allowed" }, 403, origin);
    }

    try {
      const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
      const upstreamRequest = new Request(upstreamUrl, request);
      const upstreamResponse = await fetch(upstreamRequest);
      return withCors(upstreamResponse, origin);
    } catch (error) {
      console.error(JSON.stringify({
        event: "upstream_error",
        path: url.pathname,
        message: error instanceof Error ? error.message : "unknown_error",
      }));
      return json({ error: "upstream_unavailable" }, 502, origin);
    }
  },
};

function preflight(origin, pathname) {
  if (origin !== APP_ORIGIN || !ALLOWED_ROUTES.has(pathname)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (origin === APP_ORIGIN) {
    for (const [name, value] of Object.entries(corsHeaders(origin))) {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(value, status, origin) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin === APP_ORIGIN) {
    for (const [name, headerValue] of Object.entries(corsHeaders(origin))) {
      headers.set(name, headerValue);
    }
  }
  return new Response(JSON.stringify(value), { status, headers });
}
