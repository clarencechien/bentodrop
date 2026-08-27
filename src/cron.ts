import type { Env } from "./types";

/** §10: expired messages (rows + R2 objects) and stale pairings. */
export async function cleanupExpired(env: Env, now = Date.now()): Promise<{ messages: number; pairings: number }> {
  const rows = await env.DB.prepare(
    "DELETE FROM messages WHERE expires_at <= ? RETURNING r2_key",
  ).bind(now).all<{ r2_key: string | null }>();
  const keys = (rows.results ?? []).map((r) => r.r2_key).filter((k): k is string => !!k);
  if (keys.length) await env.INBOX.delete(keys);

  const pairings = await env.DB.prepare(
    "DELETE FROM pairings WHERE expires_at <= ? RETURNING pair_id",
  ).bind(now).all();

  return { messages: rows.results?.length ?? 0, pairings: pairings.results?.length ?? 0 };
}
