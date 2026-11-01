import { expect, test } from "bun:test";
import { parseFingerprintExplain, summarizeFingerprintPreview } from "./nanfu-fingerprint-preview.ts";

const SAMPLE = `apostate fingerprint composition

  chromium            155.0.8059.85
  seed                12345

surface                                      layer             evidence               value
anchor                                       anchor            physical-ground-truth  windows-d3d11-nvidia-0947761dfbe9
gpu_identity                                 dispersion        catalogue-value        d3d11-nvidia-geforce-rtx-4060
webgpu                                       anchor            physical-ground-truth  NVIDIA GeForce RTX 4060
cpu                                          dispersion        public-corpus          cores-16
memory                                       dispersion        catalogue-value        gib-8
panel                                        dispersion        public-corpus          fhd-1080p
locale.timezone                              host-inherited    host-inherited         (inherited)
  ! no launch layer named locale.timezone
voices                                       dispersion        catalogue-value        windows-en-us.fr-fr

limitations
  - anchor is a d3d11 cluster on a swiftshader host
  - memory is host-inherited
`;

test("内核 explain：解析真实组合与限制", () => {
  const preview = parseFingerprintExplain(SAMPLE);
  const byName = Object.fromEntries(preview.surfaces.map((entry) => [entry.surface, entry]));
  expect(byName.gpu_identity!.value).toBe("d3d11-nvidia-geforce-rtx-4060");
  expect(byName.cpu!.value).toBe("cores-16");
  expect(byName.memory!.value).toBe("gib-8");
  expect(byName["locale.timezone"]!.layer).toBe("host-inherited");
  expect(preview.limitations).toHaveLength(2);
  expect(preview.limitations[0]).toContain("swiftshader");
  const summary = summarizeFingerprintPreview(preview).map((entry) => entry.surface);
  expect(summary).toContain("显卡");
  expect(summary).toContain("分辨率");
  expect(summary).not.toContain("anchor");
});
