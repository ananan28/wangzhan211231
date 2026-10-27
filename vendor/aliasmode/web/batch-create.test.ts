import { expect, test } from "bun:test";
import { createProfilesInOrder } from "./batch-create";

test("creates each profile in order", async () => {
  const calls: number[] = [];
  const result = await createProfilesInOrder(3, async (index) => {
    calls.push(index);
    return { ok: true };
  });
  expect(calls).toEqual([1, 2, 3]);
  expect(result).toEqual({ created: 3 });
});

test("stops on failure and reports completed profiles", async () => {
  const calls: number[] = [];
  const result = await createProfilesInOrder(3, async (index) => {
    calls.push(index);
    return index === 2 ? { ok: false, error: "failed" } : { ok: true };
  });
  expect(calls).toEqual([1, 2]);
  expect(result).toEqual({ created: 1, error: "failed" });
});

test("reports a thrown error without retrying", async () => {
  const result = await createProfilesInOrder(2, async () => { throw new Error("network"); });
  expect(result).toEqual({ created: 0, error: "network" });
});

test("rejects out-of-range counts", async () => {
  for (const count of [0, 101, 1.5]) {
    await expect(createProfilesInOrder(count, async () => ({ ok: true }))).rejects.toThrow();
  }
});
