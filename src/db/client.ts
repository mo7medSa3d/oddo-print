import { db, pool } from "./index";

export { db, pool };

export async function queryWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DB timeout ${label} after ${ms}ms`)), ms);
      // @ts-ignore
      timer?.unref?.();
    });
    const result = await Promise.race([promise, timeout]);
    return result as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
