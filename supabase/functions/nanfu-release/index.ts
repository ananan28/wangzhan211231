// Nanfu release channel.
//
// Download: POST {"action":"download","platform":"win-x64"} returns the latest
// installer URL on the public download domain. Downloads are open to everyone;
// only the build workflow can register a new release.
//
// Register: POST {"action":"register",...} with the x-nanfu-upload-token
// header. The Windows build workflow uploads the installer to object storage
// itself and then registers it here; the function confirms the object is
// actually downloadable before advertising it, so a broken upload never
// becomes the latest release.
//
// verify_jwt is disabled in supabase/config.toml because the two callers
// authenticate differently; every request is checked below. The service-role
// key stays in this process and is never returned, logged or echoed.

const ALLOWED_ORIGINS = [
  "https://ananan28.github.io",
  "https://xzckfn.eu.cc",
  "http://tauri.localhost",
  "http://127.0.0.1",
];
const PLATFORMS = ["win-x64", "mac-arm", "mac-intel"] as const;
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;

type Platform = (typeof PLATFORMS)[number];

interface ReleaseRow {
  version: string;
  platform: string;
  file_name: string;
  object_key: string;
  sha256: string;
  byte_size: number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-nanfu-upload-token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Length check first; equal-length inputs are compared without early exit so the
// comparison time does not reveal how many leading bytes matched.
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function env(name: string): string {
  return Deno.env.get(name) ?? "";
}

function serviceHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

function storagePath(objectKey: string): string {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function supabaseUrl(): string {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function publicBase(): string {
  return (env("NANFU_RELEASE_PUBLIC_BASE") || "https://dl.xzckfn.eu.cc").replace(
    /\/+$/,
    "",
  );
}

function unavailable(origin: string | null): Response {
  return json(
    { ok: false, error: "发布通道暂时不可用，请稍后再试。" },
    500,
    origin,
  );
}

async function handleDownload(
  req: Request,
  origin: string | null,
): Promise<Response> {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const url = supabaseUrl();
  if (!url || !serviceKey) return unavailable(origin);

  let body: { action?: string; platform?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "请求格式不正确。" }, 400, origin);
  }
  if (body?.action !== "download") {
    return json({ ok: false, error: "不支持的请求。" }, 400, origin);
  }
  const platform = body.platform;
  if (!platform || !PLATFORMS.includes(platform as Platform)) {
    return json({ ok: false, error: "不支持的平台。" }, 400, origin);
  }

  const query = new URLSearchParams({
    platform: `eq.${platform}`,
    select: "version,platform,file_name,object_key,sha256,byte_size",
    order: "published_at.desc",
    limit: "1",
  });
  const releaseRes = await fetch(`${url}/rest/v1/nanfu_releases?${query}`, {
    headers: serviceHeaders(serviceKey),
  });
  if (!releaseRes.ok) return unavailable(origin);

  let rows: ReleaseRow[] = [];
  try {
    const parsed = await releaseRes.json();
    if (Array.isArray(parsed)) rows = parsed as ReleaseRow[];
  } catch {
    rows = [];
  }
  const release = rows[0];
  if (!release || typeof release.object_key !== "string") {
    return json(
      { ok: false, error: "内测中 · 暂未开放", code: "no_release" },
      404,
      origin,
    );
  }

  return json({
    ok: true,
    version: release.version,
    platform: release.platform,
    fileName: release.file_name,
    url: `${publicBase()}/${storagePath(release.object_key)}`,
    sha256: release.sha256,
    size: release.byte_size,
    expiresIn: 0,
  }, 200, origin);
}

async function handleRegister(
  req: Request,
  origin: string | null,
): Promise<Response> {
  const configured = env("NANFU_UPLOAD_TOKEN");
  const supplied = req.headers.get("x-nanfu-upload-token") ?? "";
  if (!configured || !sameSecret(configured, supplied)) {
    return json({ ok: false, error: "上传凭据无效。" }, 401, origin);
  }

  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const url = supabaseUrl();
  if (!url || !serviceKey) return unavailable(origin);

  let body: {
    action?: string;
    version?: unknown;
    platform?: unknown;
    fileName?: unknown;
    sha256?: unknown;
    size?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "请求格式不正确。" }, 400, origin);
  }
  if (body?.action !== "register") {
    return json({ ok: false, error: "不支持的请求。" }, 400, origin);
  }

  const version = String(body.version ?? "").trim();
  const platform = String(body.platform ?? "").trim();
  const fileName = String(body.fileName ?? "").trim();
  const sha256 = String(body.sha256 ?? "").trim().toLowerCase();
  const size = Number(body.size);

  if (!VERSION_RE.test(version)) {
    return json({ ok: false, error: "版本号格式不正确。" }, 400, origin);
  }
  if (!PLATFORMS.includes(platform as Platform)) {
    return json({ ok: false, error: "不支持的平台。" }, 400, origin);
  }
  if (!SHA256_RE.test(sha256)) {
    return json({ ok: false, error: "SHA256 格式不正确。" }, 400, origin);
  }
  if (
    !Number.isFinite(size) || size <= 0 || size > MAX_RELEASE_BYTES ||
    !Number.isInteger(size)
  ) {
    return json({ ok: false, error: "安装包大小不正确。" }, 400, origin);
  }
  if (
    !fileName || fileName.length > 200 || fileName === "." ||
    fileName === ".." || /[\\/\u0000-\u001f]/.test(fileName)
  ) {
    return json({ ok: false, error: "文件名不正确。" }, 400, origin);
  }

  const prefix = (env("NANFU_RELEASE_OBJECT_PREFIX") || "nanfu").replace(
    /^\/+|\/+$/g,
    "",
  );
  const objectKey = `${prefix}/${version}/${platform}/${fileName}`;
  const publicUrl = `${publicBase()}/${storagePath(objectKey)}`;

  // Only advertise what the public domain can actually serve right now.
  const head = await fetch(publicUrl, { method: "HEAD" });
  if (!head.ok) {
    return json(
      { ok: false, error: "安装包尚未上传完成。", code: "object_missing" },
      409,
      origin,
    );
  }
  const servedSize = Number(head.headers.get("content-length"));
  if (Number.isFinite(servedSize) && servedSize > 0 && servedSize !== size) {
    return json(
      { ok: false, error: "安装包大小与登记信息不一致。", code: "size_mismatch" },
      409,
      origin,
    );
  }

  const insertRes = await fetch(
    `${url}/rest/v1/nanfu_releases?on_conflict=object_key`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        version,
        platform,
        file_name: fileName,
        object_key: objectKey,
        byte_size: size,
        sha256,
        published_at: new Date().toISOString(),
      }),
    },
  );
  if (!insertRes.ok) {
    console.error("nanfu-release metadata insert failed", insertRes.status);
    return unavailable(origin);
  }

  return json({ ok: true, objectKey, url: publicUrl, version, size }, 200, origin);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405, origin);
  }

  try {
    return req.headers.has("x-nanfu-upload-token")
      ? await handleRegister(req, origin)
      : await handleDownload(req, origin);
  } catch (error) {
    console.error(
      "nanfu-release failed",
      error instanceof Error ? error.name : "unknown",
    );
    return unavailable(origin);
  }
});
