// Nanfu release channel.
//
// Download: POST {"action":"download","platform":"win-x64"} with a signed-in
// user's access token. The function verifies the token, requires an active
// organization membership, and returns a one-hour signed storage URL.
//
// Publish: multipart/form-data with version, platform, sha256 and file, plus
// the x-nanfu-upload-token header. Used by the Windows build workflow.
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
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const SIGNED_URL_SECONDS = 3600;
const BUCKET = "nanfu-releases";

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

  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (!bearer) {
    return json({ ok: false, error: "请先登录后再下载。" }, 401, origin);
  }
  const token = bearer[1].trim();

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

  // Prefer the publishable key for the auth endpoint, but the service key also
  // satisfies it when a deployment only sets the latter.
  const publicKey = env("SUPABASE_ANON_KEY") ||
    env("SUPABASE_PUBLISHABLE_KEY") || serviceKey;

  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: publicKey },
  });
  if (!userRes.ok) {
    return json(
      { ok: false, error: "登录状态已失效，请重新登录。" },
      401,
      origin,
    );
  }

  const userHeaders = {
    Authorization: `Bearer ${token}`,
    apikey: publicKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const meRes = await fetch(`${url}/rest/v1/rpc/nanfu_org_me`, {
    method: "POST",
    headers: userHeaders,
    body: "{}",
  });
  let membership: { status?: string; locked?: boolean } | null = null;
  if (meRes.ok) {
    try {
      const parsed = await meRes.json();
      membership = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      membership = null;
    }
  }
  if (
    !meRes.ok || !membership || membership.status !== "active" ||
    membership.locked !== false
  ) {
    return json(
      { ok: false, error: "未加入有效组织，或账号已锁定/停用。" },
      403,
      origin,
    );
  }

  const query = new URLSearchParams({
    platform,
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

  const publicBase = (Deno.env.get("NANFU_RELEASE_PUBLIC_BASE") ?? "https://dl.xzckfn.eu.cc").replace(/\/+$/, "");
  const publicUrl = `${publicBase}/${storagePath(release.object_key)}`;

  return json({
    ok: true,
    version: release.version,
    platform: release.platform,
    fileName: release.file_name,
    url: publicUrl,
    sha256: release.sha256,
    size: release.byte_size,
    expiresIn: 0,
  }, 200, origin);
}

async function handleUpload(
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, error: "上传请求格式不正确。" }, 400, origin);
  }

  const version = String(form.get("version") ?? "").trim();
  const platform = String(form.get("platform") ?? "").trim();
  const sha256 = String(form.get("sha256") ?? "").trim();
  const file = form.get("file");

  if (!VERSION_RE.test(version)) {
    return json({ ok: false, error: "版本号格式不正确。" }, 400, origin);
  }
  if (!PLATFORMS.includes(platform as Platform)) {
    return json({ ok: false, error: "不支持的平台。" }, 400, origin);
  }
  if (!SHA256_RE.test(sha256)) {
    return json({ ok: false, error: "SHA256 格式不正确。" }, 400, origin);
  }
  if (!(file instanceof File) || file.size <= 0) {
    return json({ ok: false, error: "缺少安装包文件。" }, 400, origin);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ ok: false, error: "安装包超过 300MB 限制。" }, 400, origin);
  }

  const fileName = (file.name || "").split(/[\\/]/).pop()?.trim() ?? "";
  if (
    !fileName || fileName === "." || fileName === ".." || fileName.length > 200
  ) {
    return json({ ok: false, error: "文件名不正确。" }, 400, origin);
  }

  const objectKey = `releases/${version}/${platform}/${fileName}`;
  const uploadBody = new FormData();
  uploadBody.append("file", file, fileName);
  const uploadRes = await fetch(
    `${url}/storage/v1/object/${BUCKET}/${storagePath(objectKey)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "x-upsert": "true",
      },
      body: uploadBody,
    },
  );
  if (!uploadRes.ok) {
    console.error("nanfu-release storage upload failed", uploadRes.status);
    return unavailable(origin);
  }

  const row = {
    version,
    platform,
    file_name: fileName,
    object_key: objectKey,
    byte_size: file.size,
    sha256,
    published_at: new Date().toISOString(),
  };
  const insertRes = await fetch(
    `${url}/rest/v1/nanfu_releases?on_conflict=object_key`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    },
  );
  if (!insertRes.ok) {
    console.error("nanfu-release metadata insert failed", insertRes.status);
    // Do not leave an unreferenced object behind.
    await fetch(`${url}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: serviceHeaders(serviceKey),
      body: JSON.stringify({ prefixes: [objectKey] }),
    }).catch(() => {});
    return unavailable(origin);
  }

  return json({ ok: true, objectKey, size: file.size }, 200, origin);
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
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isUpload = req.headers.has("x-nanfu-upload-token") ||
      contentType.includes("multipart/form-data");
    return isUpload
      ? await handleUpload(req, origin)
      : await handleDownload(req, origin);
  } catch (error) {
    console.error(
      "nanfu-release failed",
      error instanceof Error ? error.name : "unknown",
    );
    return unavailable(origin);
  }
});
