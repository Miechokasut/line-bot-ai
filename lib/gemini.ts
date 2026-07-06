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

export const GEMINI_MODEL = "gemini-3.5-flash";
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

/** ประกอบ content: FAQ มาก่อน, question มาท้ายสุด */
function buildContents(faq: string, question: string): string {
  return `<faq>
${faq || "(ยังไม่มีข้อมูล FAQ)"}
</faq>

<question>
${question}
</question>`;
}

export async function askGemini(faq: string, question: string): Promise<GeminiResult> {
  const ai = getClient();

  const generation = ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildContents(faq, question),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
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
