import { expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags, memoryOptionsGb, normalizeGpuIdentity, normalizeMemoryGb } from "./fingerprint.ts";
import { gpuLabel, parseServableGpus } from "./nanfu-gpu-catalogue.ts";

test("内核服务清单：解析厂商/型号并去掉 ANGLE 样板", () => {
  const output = [
    "apostate: --fingerprint-gpu-vendor='x' names a GPU identity that was not measured.",
    "Servable on this host:",
    "  Google Inc. (NVIDIA) / ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "  Google Inc. (NVIDIA) / ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "Pass --fingerprint-anchor to choose a different cluster.",
  ].join("\n");
  const gpus = parseServableGpus(output);
  expect(gpus.map((gpu) => gpu.label)).toEqual(["NVIDIA GeForce RTX 4060", "NVIDIA GeForce RTX 4070"]);
  expect(gpus[0]!.vendor).toBe("Google Inc. (NVIDIA)");
  expect(gpuLabel("ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)")).toBe("ANGLE Metal Renderer: Apple M4");
  expect(parseServableGpus("no menu here")).toEqual([]);
});

test("内存与显卡声明：只接受本机内核能兑现的值", () => {
  const maxGb = memoryOptionsGb().at(-1)!;
  const profile = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const flags = deriveFingerprintFlags({
    ...profile,
    memoryGb: 32,
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  });
  expect(flags).toContain(`--fingerprint-device-memory=${maxGb}`);
  expect(flags).toContain("--fingerprint-gpu-vendor=Google Inc. (NVIDIA)");
  expect(flags).toContain("--fingerprint-gpu-renderer=ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  expect(normalizeMemoryGb("16")).toBe(16);
  expect(normalizeMemoryGb(0)).toBeUndefined();
  expect(() => normalizeMemoryGb(3)).toThrow();
  expect(normalizeGpuIdentity("", "")).toEqual({});
  expect(() => normalizeGpuIdentity("vendor", "")).toThrow();
});
