$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dist = Join-Path $root "dist"
$server = Join-Path $dist "server"

if (Test-Path -LiteralPath $dist) {
  $resolvedDist = [IO.Path]::GetFullPath($dist)
  if (-not $resolvedDist.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear a build directory outside the project."
  }
  Remove-Item -LiteralPath $resolvedDist -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $server | Out-Null

$assets = [ordered]@{}
$assetFiles = @(
  @{ Path = "index.html"; Url = "/index.html"; Type = "text/html; charset=utf-8"; Binary = $false },
  @{ Path = "config.js"; Url = "/config.js"; Type = "text/javascript; charset=utf-8"; Binary = $false },
  @{ Path = "styles.css"; Url = "/styles.css"; Type = "text/css; charset=utf-8"; Binary = $false },
  @{ Path = "app.js"; Url = "/app.js"; Type = "text/javascript; charset=utf-8"; Binary = $false },
  @{ Path = "db.js"; Url = "/db.js"; Type = "text/javascript; charset=utf-8"; Binary = $false },
  @{ Path = "sw.js"; Url = "/sw.js"; Type = "text/javascript; charset=utf-8"; Binary = $false },
  @{ Path = "manifest.webmanifest"; Url = "/manifest.webmanifest"; Type = "application/manifest+json; charset=utf-8"; Binary = $false },
  @{ Path = "public/og-v2.png"; Url = "/public/og-v2.png"; Type = "image/png"; Binary = $true },
  @{ Path = "public/favicon-32-v2.png"; Url = "/public/favicon-32-v2.png"; Type = "image/png"; Binary = $true },
  @{ Path = "public/apple-touch-icon-180-v2.png"; Url = "/public/apple-touch-icon-180-v2.png"; Type = "image/png"; Binary = $true },
  @{ Path = "public/icon-192-v2.png"; Url = "/public/icon-192-v2.png"; Type = "image/png"; Binary = $true },
  @{ Path = "public/icon-512-v2.png"; Url = "/public/icon-512-v2.png"; Type = "image/png"; Binary = $true },
  @{ Path = "public/icon-maskable-512-v2.png"; Url = "/public/icon-maskable-512-v2.png"; Type = "image/png"; Binary = $true }
)

foreach ($asset in $assetFiles) {
  $source = Join-Path $root $asset.Path
  if ($asset.Binary) {
    $assets[$asset.Url] = @{ type = $asset.Type; base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($source)) }
  } else {
    $assets[$asset.Url] = @{ type = $asset.Type; body = [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8) }
  }
}

$assetJson = $assets | ConvertTo-Json -Depth 5 -Compress
$worker = @"
import { onRequestPost as login } from "./login.js";
import { onRequestPost as logout } from "./logout.js";
import { onRequestPost as sync } from "./sync.js";

const ASSETS = $assetJson;
const ALLOWED_ORIGIN = "https://inan03091991-pixel.github.io";

function decodeBase64(value) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let apiResponse = null;
    if (request.method === "POST" && url.pathname === "/api/login") apiResponse = await login({ request, env });
    if (request.method === "POST" && url.pathname === "/api/logout") apiResponse = await logout({ request, env });
    if (request.method === "POST" && url.pathname === "/api/sync") apiResponse = await sync({ request, env });
    if (apiResponse) return withCors(apiResponse, origin);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const key = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset = ASSETS[key] || (request.headers.get("Accept")?.includes("text/html") ? ASSETS["/index.html"] : null);
    if (!asset) return new Response("Not found", { status: 404 });

    const headers = new Headers({
      "Content-Type": asset.type,
      "Cache-Control": key === "/sw.js" || key === "/index.html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://hy-nhi-github-api.inan03091991.workers.dev; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    });
    if (key === "/sw.js") headers.set("Service-Worker-Allowed", "/");
    const body = request.method === "HEAD" ? null : asset.base64 ? decodeBase64(asset.base64) : asset.body;
    return new Response(body, { status: 200, headers });
  }
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (origin === ALLOWED_ORIGIN) {
    for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
"@

[IO.File]::WriteAllText((Join-Path $server "index.js"), $worker, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $root "functions/api/login.js") -Destination (Join-Path $server "login.js")
Copy-Item -LiteralPath (Join-Path $root "functions/api/logout.js") -Destination (Join-Path $server "logout.js")
Copy-Item -LiteralPath (Join-Path $root "functions/api/sync.js") -Destination (Join-Path $server "sync.js")

Write-Output "Sites build created at $dist"
