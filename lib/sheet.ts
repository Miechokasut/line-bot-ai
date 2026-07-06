/**
 * lib/sheet.ts
 * ดึง FAQ จาก Google Sheet (published CSV) แล้วแปลงเป็นข้อความ FAQ
 * cache ผลลัพธ์ไว้ใน memory 60 วินาที เพื่อลดจำนวนครั้งที่ต้องดึง Sheet
 *
 * Error policy: ถ้าดึง Sheet ไม่ได้ จะ fallback ไปใช้ cache ล่าสุด (แม้จะหมดอายุ)
 * ถ้าไม่มี cache เลย จะ throw เพื่อให้ผู้เรียกตัดสินใจตอบ default message
 */

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

type FaqCache = {
  text: string;
  fetchedAt: number;
};

// cache แบบ module-level (คงอยู่ตลอดอายุ warm serverless instance)
let cache: FaqCache | null = null;

/**
 * คืนข้อความ FAQ พร้อมใช้กับ prompt
 * - ถ้ามี cache ที่ยังไม่หมดอายุ → คืน cache
 * - ถ้าหมดอายุ → พยายามดึงใหม่ ถ้าล้มเหลวและมี cache เก่า → คืน cache เก่า
 * - ถ้าดึงไม่ได้และไม่มี cache → throw
 */
export async function getFaqText(): Promise<string> {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.text;
  }

  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    if (cache) return cache.text;
    throw new Error("SHEET_CSV_URL is not set");
  }

  try {
    const csv = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    const text = csvToFaqText(csv);
    cache = { text, fetchedAt: now };
    return text;
  } catch (err) {
    // ดึง Sheet ไม่ได้ → ใช้ cache ล่าสุดถ้ามี
    if (cache) {
      console.warn(
        "[sheet] fetch failed, serving stale cache:",
        err instanceof Error ? err.message : err
      );
      return cache.text;
    }
    // ไม่มี cache เลย → โยนต่อให้ผู้เรียกตอบ default message
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Sheet fetch failed with status ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * แปลง CSV (schema: category, question, answer, keywords, active)
 * เป็นข้อความ FAQ ที่อ่านง่ายสำหรับโมเดล
 * นับเฉพาะแถวที่ active = TRUE
 */
export function csvToFaqText(csv: string): string {
  const rows = parseCsv(csv);
  if (rows.length === 0) return "";

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    category: header.indexOf("category"),
    question: header.indexOf("question"),
    answer: header.indexOf("answer"),
    keywords: header.indexOf("keywords"),
    active: header.indexOf("active"),
  };

  const entries: string[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0 || row.every((c) => c.trim() === "")) continue;

    const get = (col: number) => (col >= 0 && col < row.length ? row[col].trim() : "");

    // เปิด/ปิดคำตอบด้วยคอลัมน์ active — ค่าว่างถือว่าเปิด (กันกรณีไม่มีคอลัมน์)
    const activeRaw = get(idx.active).toUpperCase();
    const isActive = idx.active < 0 || activeRaw === "" || activeRaw === "TRUE";
    if (!isActive) continue;

    const category = get(idx.category);
    const question = get(idx.question);
    const answer = get(idx.answer);
    const keywords = get(idx.keywords);

    // ต้องมีอย่างน้อยคำถาม + คำตอบ ถึงจะเป็น FAQ ที่ใช้ได้
    if (!question && !answer) continue;

    const parts: string[] = [];
    if (category) parts.push(`[หมวด] ${category}`);
    if (question) parts.push(`[คำถาม] ${question}`);
    if (answer) parts.push(`[คำตอบ] ${answer}`);
    if (keywords) parts.push(`[คำสำคัญ] ${keywords}`);
    entries.push(parts.join("\n"));
  }

  return entries.join("\n\n");
}

/**
 * CSV parser แบบรองรับ quoted field (มี comma, newline, และ "" escaped quote)
 * คืนค่าเป็น array ของแถว โดยแต่ละแถวเป็น array ของ cell
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // ตัด BOM ที่ Google Sheet บางทีใส่มาต้นไฟล์
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ข้าม \r (จะจบแถวตอนเจอ \n)
    } else {
      field += ch;
    }
  }

  // แถวสุดท้าย (ถ้าไม่มี trailing newline)
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
