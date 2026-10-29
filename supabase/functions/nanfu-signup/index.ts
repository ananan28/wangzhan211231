// Website registration for Nanfu.
//
// The browser never calls Supabase Auth directly: this function verifies the
// Cloudflare Turnstile token, throttles each client address, and creates an
// already-confirmed account with the admin API. The project has no SMTP, so a
// confirmation mail would never arrive; abuse control lives in Turnstile plus
// the rolling per-IP limit in public.nanfu_signup_attempts.
//
// verify_jwt is disabled in supabase/config.toml: the caller is anonymous by
// definition. The service-role key stays in this process and is never
// returned, logged or echoed; the response carries the email only.

const ALLOWED_ORIGINS = [
  "https://ananan28.github.io",
  "https://xzckfn.eu.cc",
  "http://tauri.localhost",
  "http://127.0.0.1",
];
// Same rules as isValidNanfuEmail / isValidNanfuPassword in
// vendor/aliasmode/nanfu-account.ts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_ATTEMPTS_PER_HOUR = 5;

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
  return (first || "unknown").slice(0, 128);
}

async function countRecentAttempts(
  url: string,
  serviceKey: string,
  ip: string,
): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    select: "ip",
    ip: `eq.${ip}`,
    at: `gte.${since}`,
    limit: String(MAX_ATTEMPTS_PER_HOUR),
  });
  const res = await fetch(`${url}/rest/v1/nanfu_signup_attempts?${query}`, {
    headers: serviceHeaders(serviceKey),
  });
  if (!res.ok) throw new Error(`attempt read failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function recordAttempt(
  url: string,
  serviceKey: string,
  ip: string,
): Promise<void> {
  const res = await fetch(`${url}/rest/v1/nanfu_signup_attempts`, {
    method: "POST",
    headers: {
      ...serviceHeaders(serviceKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ip }),
  });
  if (!res.ok) throw new Error(`attempt write failed: ${res.status}`);
}

async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string,
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  if (ip !== "unknown") body.set("remoteip", ip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!res.ok) return false;

  let payload: { success?: boolean } | null = null;
  try {
    payload = await res.json();
  } catch {
    return false;
  }
  return payload?.success === true;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405, origin);
  }

  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const url = env("SUPABASE_URL").replace(/\/+$/, "");
  const turnstileSecret = env("TURNSTILE_SECRET");
  if (!serviceKey || !url || !turnstileSecret) {
    return json(
      { ok: false, error: "注册暂时不可用，请稍后再试。" },
      500,
      origin,
    );
  }

  let input: {
    email?: unknown;
    password?: unknown;
    captchaToken?: unknown;
  };
  try {
    input = await req.json();
  } catch {
    return json({ ok: false, error: "请求格式不正确。" }, 400, origin);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return json({ ok: false, error: "请求格式不正确。" }, 400, origin);
  }

  const ip = clientIp(req);
  try {
    const recent = await countRecentAttempts(url, serviceKey, ip);
    if (recent >= MAX_ATTEMPTS_PER_HOUR) {
      return json(
        { ok: false, error: "操作过于频繁，请稍后再试。" },
        429,
        origin,
      );
    }
    await recordAttempt(url, serviceKey, ip);
  } catch (error) {
    console.error(
      "nanfu-signup throttle failed",
      error instanceof Error ? error.message : "unknown",
    );
    return json(
      { ok: false, error: "注册暂时不可用，请稍后再试。" },
      500,
      origin,
    );
  }

  const captchaToken = typeof input.captchaToken === "string"
    ? input.captchaToken.trim()
    : "";
  let human = false;
  try {
    human = await verifyTurnstile(turnstileSecret, captchaToken, ip);
  } catch {
    human = false;
  }
  if (!human) {
    return json(
      { ok: false, error: "人机验证未通过，请重试。" },
      400,
      origin,
    );
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!EMAIL_RE.test(email) || password.length < MIN_PASSWORD_LENGTH) {
    return json(
      { ok: false, error: "邮箱或密码不符合要求。" },
      400,
      origin,
    );
  }

  const createRes = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });

  if (!createRes.ok) {
    let payload: { code?: unknown; error_code?: unknown; msg?: unknown } | null =
      null;
    try {
      payload = await createRes.json();
    } catch {
      payload = null;
    }
    const code = String(payload?.error_code ?? payload?.code ?? "");
    const message = String(payload?.msg ?? "").toLowerCase();
    if (
      code === "email_exists" || message.includes("already") ||
      message.includes("registered")
    ) {
      return json(
        { ok: false, error: "该邮箱已注册，请直接登录。" },
        400,
        origin,
      );
    }
    console.error("nanfu-signup admin create failed", createRes.status, code);
    return json(
      { ok: false, error: "注册暂时不可用，请稍后再试。" },
      500,
      origin,
    );
  }

  return json({ ok: true, email }, 200, origin);
});
