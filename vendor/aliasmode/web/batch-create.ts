/** Shared ceiling for single and batch creation (UI and server-side guard). */
export const MAX_BATCH_CREATE = 1000;

export async function createProfilesInOrder(
  count: number,
  create: (index: number) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ created: number; error?: string }> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_CREATE) {
    throw new Error(`创建数量必须在 1 到 ${MAX_BATCH_CREATE} 之间`);
  }
  let created = 0;
  for (let index = 1; index <= count; index++) {
    try {
      const result = await create(index);
      if (!result.ok) return { created, error: result.error || "创建失败" };
      created++;
    } catch (error) {
      return { created, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { created };
}
