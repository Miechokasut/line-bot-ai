/**
 * lib/gemini.ts
 * เรียก Google Gemini ผ่าน @google/genai
 * - model: gemini-3.5-flash
 * - temperature: 1.0
 * - maxOutputTokens: 1024
 * คืนค่าข้อความ + metadata (finishReason, thoughtsTokenCount, candidatesTokenCount)
 * เพื่อให้ผู้เรียก log และตัดสินใจ (เช่น MAX_TOKENS → ตอบ default message)
 */

import { GoogleGenAI } from "@google/genai";
import type { Turn } from "@/lib/history";

// ตั้งชื่อโมเดลผ่าน env ได้ (เผื่อเปลี่ยนโดยไม่ต้องแก้โค้ด) — default เป็นรุ่นที่มีจริงแน่นอน
// หมายเหตุ: Gemini ไม่มีรุ่น "3.5" (ไล่ 2.0 -> 2.5 -> 3) เรียกชื่อผิดจะ throw แล้วตอบ default ทุกครั้ง
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GENERATION_TIMEOUT_MS = 8_000;

export type GeminiResult = {
  text: string;
  finishReason: string | undefined;
  thoughtsTokenCount: number | undefined;
  candidatesTokenCount: number | undefined;
};

// System prompt (role / constraints / output_format) — ไม่รวม faq/question
const SYSTEM_INSTRUCTION = `<role>
คุณคือทีมข้อมูลของ Arayatime / อารยธาม ซึ่งเป็นระบบชุมชนอารยะ
</role>

<constraints>
ตอบโดยใช้ข้อมูลใน <faq> เท่านั้น
ห้ามแต่งราคา เวลา สถานที่ ขั้นตอน รายชื่อพื้นที่ หรือข้อมูลที่ไม่มีใน FAQ
ถ้าข้อมูลใน FAQ ไม่พอ ให้ตอบว่า "ขอบคุณที่สอบถามนะคะ ตอนนี้ทีมข้อมูล Arayatime ยังไม่มีข้อมูลเรื่องนี้ในระบบ ขอรับเรื่องไว้ให้ทีมงานตรวจสอบและติดต่อกลับอีกครั้งค่ะ"
โทนภาษา: สุภาพ อบอุ่น ภาษาง่าย เหมือนทีมข้อมูลคุยกับคนในชุมชนหรือคนสนใจ ไม่แข็งเกินไป ไม่ใช้ศัพท์เทคนิค
ไม่ใช้ emoji
ตอบสั้น กระชับ ความยาว 1-3 ประโยค
</constraints>

<output_format>
ภาษาไทย ไม่ใช้ markdown
</output_format>`;

let clientSingleton: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  if (!clientSingleton) {
    clientSingleton = new GoogleGenAI({ apiKey });
  }
  return clientSingleton;
}

/** เอา FAQ ไปไว้ใน system instruction (คงที่ต่อ 1 คำขอ) เพื่อให้ contents เก็บแค่บทสนทนา */
function buildSystemInstruction(faq: string): string {
  return `${SYSTEM_INSTRUCTION}

<faq>
${faq || "(ยังไม่มีข้อมูล FAQ)"}
</faq>`;
}

export async function askGemini(
  faq: string,
  question: string,
  history: Turn[] = []
): Promise<GeminiResult> {
  const ai = getClient();

  // ประกอบบทสนทนา: ประวัติเก่ามาก่อน แล้วต่อด้วยคำถามล่าสุด
  const contents = [
    ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: "user", parts: [{ text: question }] },
  ];

  const generation = ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: buildSystemInstruction(faq),
      temperature: 1.0,
      maxOutputTokens: 1024,
      // ปิด "thinking" ของ flash รุ่นใหม่ ไม่งั้นโมเดลจะใช้ token 1024 ไปกับการคิดจนหมด
      // แล้วได้ finishReason=MAX_TOKENS โดย text ว่าง → บอทตอบ default message ทุกครั้ง
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const response = await withTimeout(generation, GENERATION_TIMEOUT_MS, "gemini");

  const candidate = response.candidates?.[0];
  const usage = response.usageMetadata;

  return {
    text: response.text ?? "",
    finishReason: candidate?.finishReason,
    thoughtsTokenCount: usage?.thoughtsTokenCount,
    candidatesTokenCount: usage?.candidatesTokenCount,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
