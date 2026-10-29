import { expect, test } from "bun:test";
import { MAX_BATCH_CREATE, createProfilesInOrder } from "./batch-create";

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

test("accepts the shared 100/1000 boundaries", async () => {
  expect(MAX_BATCH_CREATE).toBe(1000);
  for (const count of [100, 1000]) {
    let calls = 0;
    const result = await createProfilesInOrder(count, async () => {
      calls++;
      return { ok: true };
    });
    expect(result).toEqual({ created: count });
    expect(calls).toBe(count);
  }
});

test("rejects out-of-range counts", async () => {
  for (const count of [0, 1001, 1.5]) {
    await expect(createProfilesInOrder(count, async () => ({ ok: true }))).rejects.toThrow();
  }
});
