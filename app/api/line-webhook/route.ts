/**
 * app/api/line-webhook/route.ts
 * LINE Messaging API webhook
 *
 * Flow:
 *  1. รับ POST /api/line-webhook
 *  2. ตรวจ signature ด้วย LINE_CHANNEL_SECRET ว่ามาจาก LINE จริง
 *  3. รับเฉพาะ event ที่เป็นข้อความตัวอักษร
 *  4. ดึง FAQ จาก Google Sheet (SHEET_CSV_URL)
 *  5. ส่ง FAQ + คำถามลูกค้าเข้า Gemini
 *  6. ถ้า finishReason === "MAX_TOKENS" → ตอบ default message ทันที
 *  7. reply กลับ LINE ด้วย LINE_CHANNEL_ACCESS_TOKEN
 *  8. พยายามจบภายใน 10 วินาที
 */

import { NextRequest } from "next/server";
import { validateSignature, messagingApi } from "@line/bot-sdk";
import { getFaqText } from "@/lib/sheet";
import { askGemini } from "@/lib/gemini";
import { getHistory, appendTurns } from "@/lib/history";

// รันบน Node.js runtime และตั้งเพดานเวลาไว้ 10 วินาที
export const runtime = "nodejs";
export const maxDuration = 10;
export const dynamic = "force-dynamic";

const DEFAULT_MESSAGE =
  "ขอบคุณที่สอบถามนะคะ ตอนนี้ทีมข้อมูล Arayatime ยังไม่มีข้อมูลเรื่องนี้ในระบบ ขอรับเรื่องไว้ให้ทีมงานตรวจสอบและติดต่อกลับอีกครั้งค่ะ";

// ---- ชนิดข้อมูลของ LINE event ที่เราสนใจ (subset) ----
type LineTextMessageEvent = {
  type: "message";
  replyToken: string;
  message: { type: "text"; text: string };
  source?: { userId?: string };
};

type LineEvent = {
  type: string;
  replyToken?: string;
  message?: { type?: string; text?: string };
  source?: { userId?: string };
};

function isTextMessageEvent(event: LineEvent): event is LineTextMessageEvent {
  return (
    event.type === "message" &&
    event.message?.type === "text" &&
    typeof event.message.text === "string" &&
    typeof event.replyToken === "string"
  );
}

export async function POST(req: NextRequest) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!channelSecret || !channelAccessToken) {
    console.error("[line-webhook] Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN");
    return new Response("Server not configured", { status: 500 });
  }

  // 2. ตรวจ signature — ต้องอ่าน raw body ก่อน
  const signature = req.headers.get("x-line-signature");
  const body = await req.text();

  if (!signature || !validateSignature(body, channelSecret, signature)) {
    console.warn("[line-webhook] Invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: { events?: LineEvent[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const events = payload.events ?? [];
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });

  // 3. รับเฉพาะข้อความตัวอักษร แล้วประมวลผลแบบขนาน
  await Promise.all(
    events.filter(isTextMessageEvent).map((event) => handleTextEvent(event, client))
  );

  // ตอบ 200 เสมอ เพื่อไม่ให้ LINE retry (error ต่าง ๆ จัดการภายในแล้ว)
  return new Response("OK", { status: 200 });
}

async function handleTextEvent(
  event: LineTextMessageEvent,
  client: messagingApi.MessagingApiClient
) {
  const userMessage = event.message.text;
  const userId = event.source?.userId ?? "";

  let reply = DEFAULT_MESSAGE;
  let finishReason: string | undefined;
  let thoughtsTokenCount: number | undefined;
  let candidatesTokenCount: number | undefined;
  let errorMessage: string | undefined;
  let faqLength = 0;
  let usedDefault = true;

  try {
    // 4. ดึง FAQ + ประวัติบทสนทนาของ user (ขนานกัน)
    const [faq, history] = await Promise.all([getFaqText(), getHistory(userId)]);
    faqLength = faq.length;

    // 5. เรียก Gemini พร้อมประวัติ เพื่อให้คุยต่อเนื่องได้
    const result = await askGemini(faq, userMessage, history);
    finishReason = result.finishReason;
    thoughtsTokenCount = result.thoughtsTokenCount;
    candidatesTokenCount = result.candidatesTokenCount;

    // 6. MAX_TOKENS หรือข้อความว่าง → ห้ามส่งคำตอบครึ่งประโยค ใช้ default message
    if (finishReason === "MAX_TOKENS" || result.text.trim() === "") {
      reply = DEFAULT_MESSAGE;
    } else {
      reply = result.text.trim();
      usedDefault = false;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    reply = DEFAULT_MESSAGE;
  }

  // 7. reply กลับ LINE — ถ้าไม่สำเร็จ log ให้ชัด แต่ไม่ retry หนักใน webhook
  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: reply }],
    });
  } catch (err) {
    console.error(
      "[line-webhook] reply failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // 8. บันทึกบทสนทนารอบนี้ เพื่อให้ข้อความถัดไปคุยต่อเนื่องได้
  try {
    await appendTurns(userId, userMessage, reply);
  } catch (err) {
    console.error(
      "[line-webhook] save history failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ทุก request ต้อง log ครบ
  console.log(
    JSON.stringify({
      tag: "line-webhook",
      userMessage,
      faqLength, // 0 = ดึง Sheet ไม่ได้/ว่าง | >0 = โหลด FAQ สำเร็จ
      usedDefault, // true = ตอบ default message | false = ตอบจากโมเดล
      finishReason, // STOP = ปกติ | MAX_TOKENS = token หมด (thinking กิน?)
      thoughtsTokenCount, // สูง = โมเดลคิดเยอะ (อาจเป็นสาเหตุ MAX_TOKENS)
      candidatesTokenCount, // 0 = ไม่ได้ตอบอะไรจริง
      error: errorMessage, // ไม่ว่าง = มี exception เช่น model ไม่มีจริง / key ผิด
    })
  );
}
