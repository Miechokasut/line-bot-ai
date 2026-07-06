/**
 * lib/history.ts
 * เก็บประวัติบทสนทนาแยกตาม LINE userId เพื่อให้บอทคุยต่อเนื่องได้
 *
 * เก็บได้ 2 แบบ (เลือกอัตโนมัติ):
 *  - ถ้าตั้ง UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → ใช้ Upstash Redis (เสถียร ข้ามอินสแตนซ์ได้)
 *  - ถ้าไม่ตั้ง → เก็บใน memory (ใช้ได้ทันทีแต่ลืมเมื่อ serverless รีเซ็ต — เหมาะกับทดสอบ)
 */

export type Turn = { role: "user" | "model"; text: string };

const MAX_TURNS = 8; // เก็บ 8 ข้อความล่าสุด (~4 รอบถาม-ตอบ) กัน prompt ยาวเกิน
const TTL_SECONDS = 60 * 60; // ลืมบทสนทนาหลังเงียบ 1 ชั่วโมง

const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = Boolean(upstashUrl && upstashToken);

// ---------- fallback: เก็บใน memory ----------
type MemEntry = { turns: Turn[]; expiresAt: number };
const mem = new Map<string, MemEntry>();

function keyFor(userId: string): string {
  return `chat:history:${userId}`;
}

/** ดึงประวัติบทสนทนาของ user (คืน [] ถ้าไม่มี/หมดอายุ) */
export async function getHistory(userId: string): Promise<Turn[]> {
  if (!userId) return [];

  if (useUpstash) {
    try {
      const raw = await upstashCommand(["GET", keyFor(userId)]);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Turn[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn("[history] upstash GET failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  const entry = mem.get(userId);
  if (!entry) return [];
  if (Date.now() > entry.expiresAt) {
    mem.delete(userId);
    return [];
  }
  return entry.turns;
}

/** เพิ่มคู่สนทนา (user + model) ล่าสุด แล้วตัดให้เหลือ MAX_TURNS */
export async function appendTurns(
  userId: string,
  userText: string,
  modelText: string
): Promise<void> {
  if (!userId) return;

  const prev = await getHistory(userId);
  const next: Turn[] = [
    ...prev,
    { role: "user" as const, text: userText },
    { role: "model" as const, text: modelText },
  ].slice(-MAX_TURNS);

  if (useUpstash) {
    try {
      await upstashCommand(["SET", keyFor(userId), JSON.stringify(next), "EX", String(TTL_SECONDS)]);
    } catch (err) {
      console.warn("[history] upstash SET failed:", err instanceof Error ? err.message : err);
    }
    return;
  }

  mem.set(userId, { turns: next, expiresAt: Date.now() + TTL_SECONDS * 1000 });
}

/** เรียก Upstash Redis REST API ด้วยคำสั่งแบบ array เช่น ["GET", key] */
async function upstashCommand(command: string[]): Promise<string | null> {
  const res = await fetch(upstashUrl as string, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstashToken as string}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Upstash HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: unknown };
  return data.result == null ? null : String(data.result);
}
