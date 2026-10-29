import { expect, test } from "bun:test";
import {
  NanfuAccountRuntime,
  NanfuAuthClient,
  NanfuAuthError,
  NanfuEmailUnverifiedError,
  NanfuAccountChangedError,
  normalizeNanfuLogin,
  type NanfuCredentialStore,
} from "./nanfu-account.ts";
import { DesktopCredentialBridge, DESKTOP_PROTOCOL } from "./desktop-runtime.ts";

const SESSION = (access = "access-1", refresh = "refresh-1", expiresIn = 3600) => ({
  access_token: access,
  refresh_token: refresh,
  expires_in: expiresIn,
  user: { id: "user-1", email: "user@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
});

function client(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs = 1_000) {
  return new NanfuAuthClient({
    baseUrl: "https://nanfu.test/",
    anonKey: "anon-key",
    fetchFn,
    requestTimeoutMs: timeoutMs,
    nowMs: () => 1_000,
  });
}

function memoryStore(initial: string | null = null) {
  const values: { token: string | null; saves: string[]; clears: number } = { token: initial, saves: [], clears: 0 };
  const store: NanfuCredentialStore = {
    load: async () => values.token,
    save: async (token) => {
      values.token = token;
      values.saves.push(token);
    },
    clear: async () => {
      values.token = null;
      values.clears++;
    },
  };
  return { store, values };
}

test("Nanfu account rejects insecure non-loopback service URLs", () => {
  expect(() => new NanfuAuthClient({ baseUrl: "http://nanfu.example", anonKey: "anon" }))
    .toThrow("Nanfu account service URL must use HTTPS");
});

test("sign-up sends only the anon key and reports when the email must be verified", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const auth = client(async (nextUrl, nextInit) => {
    url = String(nextUrl);
    init = nextInit;
    return Response.json({ id: "user-1", email: "user@example.com", email_confirmed_at: null });
  });
  expect(await auth.signUp("  user@example.com ", "secret123")).toEqual({
    email: "user@example.com",
    verificationRequired: true,
  });
  expect(url).toBe("https://nanfu.test/auth/v1/signup");
  const headers = new Headers(init?.headers);
  expect(headers.get("apikey")).toBe("anon-key");
  expect(headers.get("authorization")).toBeNull();
  expect(JSON.parse(String(init?.body))).toEqual({ email: "user@example.com", password: "secret123" });
});

test("sign-in keeps the access token in memory and persists only the refresh token", async () => {
  const { store, values } = memoryStore();
  const runtime = new NanfuAccountRuntime(
    client(async () => Response.json(SESSION())),
    { credentials: store, nowMs: () => 1_000 },
  );
  expect(await runtime.signIn("user@example.com", "secret123")).toEqual({
    authenticated: true,
    email: "user@example.com",
    userId: "user-1",
    expiresAt: 3_601_000,
  });
  expect(values.saves).toEqual(["refresh-1"]);
  expect(await runtime.accessTokenOrRefresh()).toBe("access-1");
});

test("an unverified account cannot start a session", async () => {
  const runtime = new NanfuAccountRuntime(client(async () => Response.json({
    ...SESSION(),
    user: { id: "user-1", email: "user@example.com", email_confirmed_at: null },
  })));
  await expect(runtime.signIn("user@example.com", "secret123")).rejects.toBeInstanceOf(NanfuEmailUnverifiedError);
  expect(runtime.state()).toEqual({ authenticated: false });
});

test("restore refreshes the stored token and rotates the persisted secret", async () => {
  const { store, values } = memoryStore("refresh-old");
  const seen: string[] = [];
  const runtime = new NanfuAccountRuntime(
    client(async (url, init) => {
      seen.push(String(url));
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "refresh-old" });
      return Response.json(SESSION("access-2", "refresh-new"));
    }),
    { credentials: store, nowMs: () => 1_000 },
  );
  expect(await runtime.restore()).toEqual({
    authenticated: true,
    email: "user@example.com",
    userId: "user-1",
    expiresAt: 3_601_000,
  });
  expect(seen[0]).toBe("https://nanfu.test/auth/v1/token?grant_type=refresh_token");
  expect(values.saves).toEqual(["refresh-new"]);
});

test("restore drops a rejected refresh token but rethrows a transport failure", async () => {
  const rejected = memoryStore("refresh-old");
  const auth = new NanfuAccountRuntime(
    client(async () => Response.json({ message: "invalid refresh token" }, { status: 400 })),
    { credentials: rejected.store, nowMs: () => 1_000 },
  );
  expect(await auth.restore()).toEqual({ authenticated: false });
  expect(rejected.values.clears).toBe(1);
  expect(rejected.values.token).toBeNull();

  const offline = memoryStore("refresh-old");
  const runtime = new NanfuAccountRuntime(
    client(async () => {
      throw new Error("offline");
    }),
    { credentials: offline.store, nowMs: () => 1_000 },
  );
  const failure = runtime.restore();
  await expect(failure).rejects.toBeInstanceOf(NanfuAuthError);
  await failure.catch((error: NanfuAuthError) => {
    expect(error.failure).toEqual({ kind: "transport", retryable: true });
  });
  expect(offline.values.token).toBe("refresh-old");
});

test("an expired access token is refreshed exactly once for concurrent callers", async () => {
  let now = 1_000;
  let refreshes = 0;
  const auth = new NanfuAccountRuntime(
    new NanfuAuthClient({
      baseUrl: "https://nanfu.test",
      anonKey: "anon-key",
      nowMs: () => now,
      fetchFn: async (url) => {
        if (String(url).includes("grant_type=password")) return Response.json(SESSION("access-1", "refresh-1", 60));
        refreshes++;
        return Response.json(SESSION("access-2", "refresh-2", 60));
      },
    }),
    { nowMs: () => now },
  );
  await auth.signIn("user@example.com", "secret123");
  now = 2_000_000;
  const [first, second] = await Promise.all([auth.accessTokenOrRefresh(), auth.accessTokenOrRefresh()]);
  expect([first, second]).toEqual(["access-2", "access-2"]);
  expect(refreshes).toBe(1);
});

test("sign-out clears local and stored state even when the service is unreachable", async () => {
  const { store, values } = memoryStore();
  const runtime = new NanfuAccountRuntime(
    client(async (url) => {
      if (String(url).includes("/logout")) throw new Error("offline");
      return Response.json(SESSION());
    }),
    { credentials: store, nowMs: () => 1_000 },
  );
  await runtime.signIn("user@example.com", "secret123");
  await runtime.signOut();
  expect(runtime.state()).toEqual({ authenticated: false });
  expect(await runtime.accessTokenOrRefresh()).toBeUndefined();
  expect(values.token).toBeNull();
});

test("changing the password proves the current password before updating", async () => {
  const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
  const runtime = new NanfuAccountRuntime(
    new NanfuAuthClient({
      baseUrl: "https://nanfu.test",
      anonKey: "anon-key",
      nowMs: () => 1_000,
      fetchFn: async (url, init) => {
        const path = String(url);
        calls.push({ url: path, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        if (path.includes("grant_type=password")) return Response.json(SESSION("access-2", "refresh-2"));
        return Response.json({});
      },
    }),
    { nowMs: () => 1_000 },
  );
  await runtime.signIn("user@example.com", "old-secret");
  await runtime.changePassword("old-secret", "new-secret");
  expect(calls.map((call) => call.url)).toEqual([
    "https://nanfu.test/auth/v1/token?grant_type=password",
    "https://nanfu.test/auth/v1/token?grant_type=password",
    "https://nanfu.test/auth/v1/user",
  ]);
  expect(calls[1]?.body).toEqual({ email: "user@example.com", password: "old-secret" });
  expect(calls[2]?.body).toEqual({ password: "new-secret" });
  expect(calls[2]?.authorization).toBe("Bearer access-2");
});

test("changing the password stops when the current password is rejected", async () => {
  let tokenCalls = 0;
  const calls: string[] = [];
  const runtime = new NanfuAccountRuntime(
    new NanfuAuthClient({
      baseUrl: "https://nanfu.test",
      anonKey: "anon-key",
      nowMs: () => 1_000,
      fetchFn: async (url) => {
        const path = String(url);
        calls.push(path);
        if (path.includes("grant_type=password")) {
          tokenCalls++;
          return tokenCalls === 1
            ? Response.json(SESSION())
            : Response.json({ message: "invalid credentials" }, { status: 400 });
        }
        return Response.json({});
      },
    }),
    { nowMs: () => 1_000 },
  );
  await runtime.signIn("user@example.com", "old-secret");
  await expect(runtime.changePassword("wrong-secret", "new-secret")).rejects.toBeInstanceOf(NanfuAuthError);
  expect(calls.some((path) => path.endsWith("/user"))).toBe(false);
  expect(runtime.state().authenticated).toBe(true);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Fails fast instead of leaving the runner blocked on a gate that never releases. */
function deadline<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

for (const action of ["signin", "restore"] as const) {
  test(`late ${action} cannot revive a signed-out session`, async () => {
    const started = gate();
    const response = gate();
    const { store, values } = memoryStore(action === "restore" ? "refresh-old" : null);
    const runtime = new NanfuAccountRuntime(client(async () => {
      started.release();
      await response.promise;
      return Response.json(SESSION());
    }), { credentials: store, nowMs: () => 1_000 });
    const pending = action === "signin" ? runtime.signIn("user@example.com", "secret123") : runtime.restore();
    const settled = pending.then(() => null, (error) => error);
    await deadline(started.promise, "sign-in request started");
    await deadline(runtime.signOut(), "sign-out");
    response.release();
    expect(await deadline(settled, "late sign-in rejection")).toBeInstanceOf(NanfuAccountChangedError);
    expect(runtime.state()).toEqual({ authenticated: false });
    expect(values.token).toBeNull();
    expect(values.saves).toEqual([]);
  });
}

test("concurrent restores share one refresh and one credential rotation", async () => {
  const response = gate();
  const { store, values } = memoryStore("refresh-old");
  let refreshes = 0;
  const runtime = new NanfuAccountRuntime(client(async () => {
    refreshes++;
    await response.promise;
    return Response.json(SESSION());
  }), { credentials: store, nowMs: () => 1_000 });
  const first = runtime.restore();
  const second = runtime.restore();
  expect(first).toBe(second);
  response.release();
  await Promise.all([deadline(first, "first restore"), deadline(second, "second restore")]);
  expect(refreshes).toBe(1);
  expect(values.saves).toEqual(["refresh-1"]);
});

test("logout serializes behind a pending credential save and leaves no saved session", async () => {
  const started = gate();
  const saved = gate();
  const { store, values } = memoryStore();
  const runtime = new NanfuAccountRuntime(client(async () => Response.json(SESSION())), {
    credentials: {
      ...store,
      save: async token => { started.release(); await saved.promise; await store.save(token); },
    },
    nowMs: () => 1_000,
  });
  const pending = runtime.signIn("user@example.com", "secret123");
  const settled = pending.then(() => null, (error) => error);
  await deadline(started.promise, "credential save started");
  const logout = runtime.signOut();
  expect(runtime.state()).toEqual({ authenticated: false });
  saved.release();
  expect(await deadline(settled, "save interrupted by logout")).toBeInstanceOf(NanfuAccountChangedError);
  await deadline(logout, "logout after pending save");
  expect(values.saves).toEqual(["refresh-1"]);
  expect(values.token).toBeNull();
});

test("late refresh and logout responses cannot erase a newer login", async () => {
  const refreshStarted = gate();
  const refreshResponse = gate();
  const logoutStarted = gate();
  const logoutResponse = gate();
  let now = 1_000;
  let logins = 0;
  const { store, values } = memoryStore();
  const runtime = new NanfuAccountRuntime(new NanfuAuthClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", nowMs: () => now,
    fetchFn: async url => {
      if (String(url).includes("grant_type=refresh_token")) {
        refreshStarted.release(); await refreshResponse.promise;
        return Response.json(SESSION("late-access", "late-refresh"));
      }
      if (String(url).includes("/logout")) {
        logoutStarted.release(); await logoutResponse.promise;
        return new Response(null, { status: 204 });
      }
      return Response.json(SESSION(`access-${++logins}`, `refresh-${logins}`, 60));
    },
  }), { credentials: store, nowMs: () => now });
  await runtime.signIn("user@example.com", "secret123");
  now = 100_000;
  const refreshing = runtime.accessTokenOrRefresh();
  await deadline(refreshStarted.promise, "refresh request started");
  await runtime.signOut();
  await runtime.signIn("user@example.com", "secret123");
  refreshResponse.release();
  expect(await deadline(refreshing, "late refresh")).toBeUndefined();
  expect(values.token).toBe("refresh-2");
  const logout = runtime.signOut();
  await deadline(logoutStarted.promise, "logout request started");
  await runtime.signIn("user@example.com", "secret123");
  logoutResponse.release();
  await deadline(logout, "logout interrupted by newer login");
  expect(values.token).toBe("refresh-3");
  expect(await runtime.accessTokenOrRefresh()).toBe("access-3");
});

test("without native credentials a new runtime has no persisted session", async () => {
  const auth = client(async () => Response.json(SESSION()));
  const runtime = new NanfuAccountRuntime(auth, { nowMs: () => 1_000 });
  await runtime.signIn("user@example.com", "secret123");
  expect(runtime.state().authenticated).toBe(true);
  expect(await new NanfuAccountRuntime(auth).restore()).toEqual({ authenticated: false });
  expect(JSON.stringify(runtime.state())).not.toContain("refresh-1");
  expect(JSON.stringify(runtime.state())).not.toContain("access-1");
});

test("Nanfu credential bridge reads, rotates and clears only its own key", async () => {
  const nonce = "ab".repeat(32);
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(nonce, line => { output.push(line); });
  for (const action of ["read", "save", "clear"] as const) {
    const pending = action === "read" ? bridge.loadNanfuRefreshToken()
      : action === "save" ? bridge.saveNanfuRefreshToken("synthetic-refresh") : bridge.clearNanfuRefreshToken();
    const request = JSON.parse(output.at(-1)!);
    expect(request.key).toBe("nanfu_refresh_token");
    expect(request.event).toBe(action === "read" ? "credential-get" : action === "save" ? "credential-set" : "credential-delete");
    expect(request.secret).toBe(action === "save" ? "synthetic-refresh" : undefined);
    const result = { protocol: DESKTOP_PROTOCOL, event: "credential-result", nonce, request: request.request, ok: true, secret: "synthetic-refresh" };
    expect(bridge.handleLine(JSON.stringify({ ...result, nonce: "cd".repeat(32) }))).toBe(false);
    expect(bridge.handleLine(JSON.stringify(result))).toBe(true);
    expect(await pending).toBe(action === "read" ? "synthetic-refresh" : undefined);
  }
  expect(output.map(line => JSON.parse(line).key)).toEqual(Array(3).fill("nanfu_refresh_token"));
});

test("Nanfu credential reads reject malformed acknowledgements without exposing secrets", async () => {  const nonce = "ab".repeat(32);
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(nonce, line => { output.push(line); });
  for (const secret of [null, { token: "synthetic-secret" }]) {
    const pending = bridge.loadNanfuRefreshToken();
    const request = JSON.parse(output.at(-1)!);
    bridge.handleLine(JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "credential-result", nonce, request: request.request, ok: true, secret }));
    if (secret === null) expect(await pending).toBeNull();
    else await expect(pending).rejects.toThrow("could not read the saved session");
  }
});

test("a bare login name becomes a local address so sub-accounts need no inbox", () => {
  expect(normalizeNanfuLogin(" Z.Sub ")).toBe("z.sub@nanfu.local");
  expect(normalizeNanfuLogin("xiaoli")).toBe("xiaoli@nanfu.local");
  expect(normalizeNanfuLogin(" Owner@Example.com ")).toBe("owner@example.com");
});
