/**
 * 指纹自检：在环境自己的浏览器里跑探针，再把读数与该环境的档案声明逐项比对。
 *
 * 探针实现只有一份：docs/fingerprint-probe.html 里 nanfu-probe-core 标记之间
 * 的原文。这里只负责取出这段原文，通过 launcher 已有的 CDP 调试端点注入到
 * 该环境新开的一个空白标签页里，不复制任何采集逻辑，也不在管理器进程里伪造
 * 指纹。标记内的代码必须保持无 DOM 依赖（页面自身的渲染在标记之外）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { platformFromUA } from "./fingerprint.ts";
import type { Profile } from "./types.ts";

const CORE_START = "/* ===== nanfu-probe-core:start =====";
const CORE_END = "/* ===== nanfu-probe-core:end ===== */";

/** 探针页在仓库里的唯一位置；打包后也按同一相对布局查找。 */
export const PROBE_HTML_CANDIDATES = [
  "../../docs/fingerprint-probe.html",
  "../docs/fingerprint-probe.html",
  "docs/fingerprint-probe.html",
] as const;

export class ProbeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeSourceError";
  }
}

function readProbeHtml(explicitPath?: string): { html: string; path: string } {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.NANFU_FINGERPRINT_PROBE) candidates.push(process.env.NANFU_FINGERPRINT_PROBE);
  for (const relative of PROBE_HTML_CANDIDATES) candidates.push(join(import.meta.dir, relative));
  candidates.push(join(process.cwd(), "docs", "fingerprint-probe.html"));
  candidates.push(join(dirname(process.execPath), "docs", "fingerprint-probe.html"));
  for (const path of candidates) {
    try {
      if (existsSync(path)) return { html: readFileSync(path, "utf8"), path };
    } catch {
      // 继续找下一个候选路径。
    }
  }
  throw new ProbeSourceError("找不到指纹探针页 docs/fingerprint-probe.html，无法执行自检");
}

/** 从探针页里取出采集核心的原文。页面与自检读的是同一份文本。 */
export function extractProbeCore(html: string): string {
  const start = html.indexOf(CORE_START);
  if (start < 0) throw new ProbeSourceError("探针页缺少 nanfu-probe-core 起始标记");
  const bodyStart = html.indexOf("\n", start);
  if (bodyStart < 0) throw new ProbeSourceError("探针页的采集核心标记不完整");
  const end = html.indexOf(CORE_END, bodyStart);
  if (end < 0) throw new ProbeSourceError("探针页缺少 nanfu-probe-core 结束标记");
  const source = html.slice(bodyStart + 1, end).trimEnd();
  if (!source.includes("async function runProbe")) {
    throw new ProbeSourceError("探针页的采集核心缺少 runProbe");
  }
  return `${source}\n`;
}

export interface ProbeSource {
  source: string;
  version: string;
  digest: string;
  htmlPath: string;
}

/** 供运行时与测试使用：同一路径只读一次，返回原文、版本和内容摘要。 */
export function loadProbeSource(options: { path?: string; html?: string } = {}): ProbeSource {
  const { html, path } = options.html !== undefined
    ? { html: options.html, path: options.path ?? "(inline)" }
    : readProbeHtml(options.path);
  const source = extractProbeCore(html);
  return {
    source,
    version: probeVersion(source),
    digest: createHash("sha256").update(source, "utf8").digest("hex"),
    htmlPath: path,
  };
}

export function probeVersion(source: string): string {
  const match = /const PROBE_VERSION = "([^"]+)";/.exec(source);
  if (!match) throw new ProbeSourceError("探针核心没有声明 PROBE_VERSION");
  return match[1]!;
}

/* ------------------------------------------------------------------ */
/* 比对                                                               */
/* ------------------------------------------------------------------ */

export type SelfCheckState = "pass" | "mismatch" | "unknown";

export interface FingerprintDeclaration {
  platform: string | null;
  timezone: string | null;
  locale: string | null;
  cores: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  ua: string | null;
}

export interface SelfCheckItem {
  field: string;
  label: string;
  state: SelfCheckState;
  declared: string;
  observed: string;
  detail: string;
}

export interface FingerprintSelfCheckReport {
  passed: SelfCheckItem[];
  mismatched: SelfCheckItem[];
  undetermined: SelfCheckItem[];
  probe: {
    version: string;
    hash: string;
    capturedAt: string;
    notes: string[];
  };
}

export interface ProbeDocument {
  probe?: { version?: string; generated_at?: string };
  signals?: {
    user_agent?: string;
    platform?: string;
    hardware_concurrency?: number | null;
    language?: string;
    languages?: string[];
    time?: { intl_timezone?: string | null };
    screen_geometry?: { width?: number; height?: number };
  };
  hashes?: { stable_fnv64?: string };
  notes?: string[];
}

/** 档案声明只取耐久字段：平台、时区、语言、核心数、屏幕、UA。 */
export function declarationFromProfile(
  profile: Pick<Profile, "platformOs" | "ua" | "timezone" | "locale" | "hardware" | "screenWidth" | "screenHeight">,
): FingerprintDeclaration {
  const platform = ((profile.platformOs || platformFromUA(profile.ua) || "") as string).trim().toLowerCase();
  return {
    platform: platform || null,
    timezone: (profile.timezone || "").trim() || null,
    locale: (profile.locale || "").trim() || null,
    cores: typeof profile.hardware?.cores === "number" ? profile.hardware.cores : null,
    screenWidth: Number.isFinite(profile.screenWidth) ? profile.screenWidth : null,
    screenHeight: Number.isFinite(profile.screenHeight) ? profile.screenHeight : null,
    ua: (profile.ua || "").trim() || null,
  };
}

/** navigator.platform 的操作系统族；认不出的返回 null（无法判定）。 */
export function osFromNavigatorPlatform(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("win")) return "windows";
  if (raw.startsWith("mac")) return "macos";
  if (raw.includes("linux") || raw.includes("x11")) return "linux";
  return null;
}

const stateOf = (declared: string, observed: string, equal: boolean): SelfCheckState => {
  if (!declared) return "unknown";
  if (!observed) return "unknown";
  return equal ? "pass" : "mismatch";
};

function item(
  field: string,
  label: string,
  declared: string | null,
  observed: string | null,
  equal: boolean,
  missingDeclared: string,
  missingObserved: string,
): SelfCheckItem {
  const d = declared ?? "";
  const o = observed ?? "";
  const state = stateOf(d, o, equal);
  const detail = state === "pass"
    ? "页面读数与档案声明一致。"
    : state === "mismatch"
      ? `不一致：档案声明 ${d}，页面读到 ${o}。`
      : !d ? missingDeclared : missingObserved;
  return { field, label, state, declared: d, observed: o, detail };
}

/**
 * 三态分类：能比且相同 → 通过；能比且不同 → 不一致；档案没声明或页面没
 * 返回 → 无法判定。无法判定不是通过，避免把「没测到」说成「没问题」。
 */
export function compareFingerprint(
  declaration: FingerprintDeclaration,
  doc: ProbeDocument,
): FingerprintSelfCheckReport {
  const signals = doc.signals ?? {};
  const declaredPlatform = declaration.platform;
  const rawPlatform = (signals.platform ?? "").trim() || null;
  const observedOs = osFromNavigatorPlatform(rawPlatform);
  const platformItem = item(
    "platform",
    "平台",
    declaredPlatform,
    observedOs ? `${observedOs}（navigator.platform=${rawPlatform}）` : rawPlatform,
    !!declaredPlatform && !!observedOs && declaredPlatform === observedOs,
    "档案未声明平台，无法比对。",
    "页面没有返回可识别的 navigator.platform。",
  );

  const declaredTimezone = declaration.timezone;
  const observedTimezone = (signals.time?.intl_timezone ?? "").trim() || null;
  const timezoneItem = item(
    "timezone",
    "时区",
    declaredTimezone,
    observedTimezone,
    !!declaredTimezone && !!observedTimezone && declaredTimezone === observedTimezone,
    "档案未声明时区，无法比对。",
    "页面没有返回 Intl 时区。",
  );

  const declaredLocale = declaration.locale;
  const observedLocale = ((signals.language ?? signals.languages?.[0]) ?? "").trim() || null;
  const localeKey = (value: string) => value.replace(/_/g, "-").toLowerCase();
  const localeItem = item(
    "locale",
    "语言",
    declaredLocale,
    observedLocale,
    !!declaredLocale && !!observedLocale && localeKey(declaredLocale) === localeKey(observedLocale),
    "档案未声明语言，无法比对。",
    "页面没有返回 navigator.language。",
  );

  const declaredCores = declaration.cores;
  const observedCores = typeof signals.hardware_concurrency === "number" ? String(signals.hardware_concurrency) : null;
  const coresItem = item(
    "hardware.cores",
    "逻辑核心数",
    declaredCores === null ? null : String(declaredCores),
    observedCores,
    declaredCores !== null && observedCores !== null && declaredCores === Number(observedCores),
    "档案未声明逻辑核心数，无法比对。",
    "页面没有返回 navigator.hardwareConcurrency。",
  );

  const hasScreen = declaration.screenWidth !== null && declaration.screenHeight !== null;
  const screenDeclared = hasScreen ? `${declaration.screenWidth}×${declaration.screenHeight}` : null;
  const width = signals.screen_geometry?.width;
  const height = signals.screen_geometry?.height;
  const screenObserved = typeof width === "number" && typeof height === "number" ? `${width}×${height}` : null;
  const screenItem = item(
    "screen",
    "屏幕分辨率",
    screenDeclared,
    screenObserved,
    hasScreen && screenObserved !== null && screenDeclared === screenObserved,
    "档案未声明屏幕分辨率，无法比对。",
    "页面没有返回屏幕几何。",
  );

  const declaredUa = declaration.ua;
  const observedUa = (signals.user_agent ?? "").trim() || null;
  const uaItem = item(
    "ua",
    "浏览器 UA",
    declaredUa,
    observedUa,
    !!declaredUa && !!observedUa && declaredUa === observedUa,
    "档案未声明 UA（由种子生成），无法比对。",
    "页面没有返回 navigator.userAgent。",
  );

  const all = [platformItem, timezoneItem, localeItem, coresItem, screenItem, uaItem];
  // UA 由内核按种子与内核版本重新生成，版本变化不是指纹漂移；提示但不算不一致。
  const uaMismatchOnlyVersion = uaItem.state === "mismatch"
    && uaItem.declared.replace(/Chrome\/[\d.]+/, "Chrome/x") === uaItem.observed.replace(/Chrome\/[\d.]+/, "Chrome/x");
  if (uaMismatchOnlyVersion) {
    uaItem.state = "unknown";
    uaItem.detail = "页面 UA 与档案声明仅 Chrome 版本不同：内核会按种子与自身版本重建 UA，这一项无法按字面判定。";
  }
  return {
    passed: all.filter(entry => entry.state === "pass"),
    mismatched: all.filter(entry => entry.state === "mismatch"),
    undetermined: all.filter(entry => entry.state === "unknown"),
    probe: {
      version: doc.probe?.version ?? "",
      hash: doc.hashes?.stable_fnv64 ?? "",
      capturedAt: doc.probe?.generated_at ?? "",
      notes: Array.isArray(doc.notes) ? doc.notes.slice() : [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* CDP 执行                                                           */
/* ------------------------------------------------------------------ */

interface PendingCall {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      let message: any;
      try { message = JSON.parse(text); } catch { return; }
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(String(message.error.message || "CDP 调用失败")));
      else call.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => { this.failAll(new Error("CDP 连接已关闭")); });
    socket.addEventListener("error", () => { this.failAll(new Error("CDP 连接失败")); });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接环境调试端口超时")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("环境调试端口拒绝连接")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = 15_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try { this.socket.send(JSON.stringify(payload)); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("CDP 连接已关闭"));
    try { this.socket.close(); } catch { /* 已断开 */ }
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}

export interface ProbeRunOptions {
  timeoutMs?: number;
  source?: string;
}

/**
 * 在该环境的浏览器里跑探针：新建一个空白标签页（仍属于同一个浏览器进程，
 * 跟随它的代理与内核指纹），注入探针核心，取回 JSON，然后关掉这个标签页。
 */
export async function runProbeOverCdp(wsUrl: string, options: ProbeRunOptions = {}): Promise<ProbeDocument> {
  const source = options.source ?? loadProbeSource().source;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const client = await CdpClient.connect(wsUrl, 5_000);
  let targetId: string | null = null;
  try {
    const created = await client.send("Target.createTarget", { url: "about:blank" });
    targetId = typeof created.targetId === "string" ? created.targetId : null;
    if (!targetId) throw new Error("无法在环境中新建标签页");
    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = typeof attached.sessionId === "string" ? attached.sessionId : "";
    if (!sessionId) throw new Error("无法附加到环境标签页");
    const expression = `(async () => {\n${source}\nreturn await runProbe();\n})()`;
    const evaluated = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: timeoutMs,
    }, sessionId, timeoutMs + 5_000);
    if (evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception?.description
        || evaluated.exceptionDetails.text
        || "探针脚本抛出异常";
      throw new Error(String(detail).split("\n")[0]);
    }
    const value = evaluated.result?.value;
    if (!value || typeof value !== "object" || !value.signals) {
      throw new Error("探针没有返回有效的信号 JSON");
    }
    return value as ProbeDocument;
  } finally {
    if (targetId) await client.send("Target.closeTarget", { targetId }).catch(() => {});
    client.close();
  }
}

/* ------------------------------------------------------------------ */
/* 请求处理                                                           */
/* ------------------------------------------------------------------ */

export interface SelfCheckLaunch {
  debugPort: number;
  engine?: "chromium" | "firefox";
}

export interface FingerprintSelfCheckDeps {
  getProfile(profileId: string): Pick<Profile, "id" | "engine" | "platformOs" | "ua" | "timezone" | "locale" | "hardware" | "screenWidth" | "screenHeight"> | null;
  getLaunch(profileId: string): SelfCheckLaunch | null;
  active(profileId: string): Promise<boolean>;
  /** 与 launcher 相同的方式在调试端口上读 /json/version。 */
  endpoint?: (debugPort: number) => Promise<string | null>;
  runProbe?: (wsUrl: string) => Promise<ProbeDocument>;
  source?: string;
}

export interface FingerprintSelfCheckOutcome {
  status: number;
  body: Record<string, unknown>;
}

async function defaultEndpoint(debugPort: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const data = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof data.webSocketDebuggerUrl === "string" && data.webSocketDebuggerUrl.startsWith("ws")
      ? data.webSocketDebuggerUrl
      : null;
  } catch {
    return null;
  }
}

export async function fingerprintSelfCheck(
  profileId: string,
  deps: FingerprintSelfCheckDeps,
): Promise<FingerprintSelfCheckOutcome> {
  const id = (profileId ?? "").trim();
  if (!id) return { status: 400, body: { ok: false, error: "缺少环境 ID" } };
  const profile = deps.getProfile(id);
  if (!profile) return { status: 404, body: { ok: false, error: "找不到该环境" } };
  const launch = deps.getLaunch(id);
  if (!launch) {
    return { status: 409, body: { ok: false, code: "nanfu_env_not_running", error: "请先启动该环境" } };
  }
  if (launch.engine === "firefox" || profile.engine === "firefox") {
    return { status: 400, body: { ok: false, error: "该环境使用 Firefox 内核，暂不支持指纹自检" } };
  }
  const running = await deps.active(id).catch(() => false);
  if (!running) {
    return { status: 409, body: { ok: false, code: "nanfu_env_not_running", error: "请先启动该环境（浏览器当前未运行）" } };
  }
  let source: string;
  try {
    source = deps.source ?? loadProbeSource().source;
  } catch (error) {
    return { status: 500, body: { ok: false, error: (error as Error).message } };
  }
  const wsUrl = await (deps.endpoint ?? defaultEndpoint)(launch.debugPort);
  if (!wsUrl) {
    return { status: 502, body: { ok: false, error: "无法连接该环境的调试端口，请重启该环境后重试" } };
  }
  let doc: ProbeDocument;
  try {
    doc = await (deps.runProbe ?? ((url: string) => runProbeOverCdp(url, { source })))(wsUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 502, body: { ok: false, error: `在环境浏览器中采集失败：${message}` } };
  }
  return {
    status: 200,
    body: { ok: true, result: compareFingerprint(declarationFromProfile(profile), doc) },
  };
}
