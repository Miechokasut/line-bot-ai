/**
 * app/api/health/route.ts
 * หน้าตรวจสุขภาพระบบ (diagnostic) — เปิดใน browser: /api/health
 * ใช้หาสาเหตุว่าทำไมบอทตอบ default ตลอด โดยไม่เปิดเผยค่า secret จริง
 *
 * ⚠️ เป็น endpoint ชั่วคราวสำหรับ debug — เมื่อแก้เสร็จควรลบไฟล์นี้ทิ้ง
 */

import { getFaqText } from "@/lib/sheet";
import { askGemini, GEMINI_MODEL } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET() {
  const report: Record<string, unknown> = {
    model: GEMINI_MODEL,
    env: {
      LINE_CHANNEL_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
      LINE_CHANNEL_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      SHEET_CSV_URL: Boolean(process.env.SHEET_CSV_URL),
    },
  };

  // 0) ดึง CSV ดิบตรง ๆ เพื่อดูว่า Sheet ส่งอะไรมาจริง (HTML? headers ตรงไหม?)
  const sheetUrl = process.env.SHEET_CSV_URL;
  if (sheetUrl) {
    try {
      const res = await fetch(sheetUrl, { cache: "no-store", redirect: "follow" });
      const body = await res.text();
      const firstLine = body.split("\n")[0] ?? "";
      report.sheetRaw = {
        httpStatus: res.status,
        contentType: res.headers.get("content-type"),
        looksLikeHtml: /<!doctype html|<html/i.test(body.slice(0, 300)),
        rawLength: body.length,
        headerLine: firstLine.slice(0, 300),
        rawPreview: body.slice(0, 400),
      };
    } catch (err) {
      report.sheetRaw = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 1) ทดสอบดึง FAQ จาก Google Sheet (ผ่านตัวแปลง csvToFaqText)
  let faq = "";
  try {
    faq = await getFaqText();
    report.sheet = {
      ok: true,
      faqLength: faq.length,
      preview: faq.slice(0, 200),
    };
  } catch (err) {
    report.sheet = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2) ทดสอบเรียก Gemini ด้วยคำถามง่าย ๆ
  try {
    const result = await askGemini(faq, "สวัสดีครับ ทดสอบระบบ");
    report.gemini = {
      ok: true,
      finishReason: result.finishReason,
      thoughtsTokenCount: result.thoughtsTokenCount,
      candidatesTokenCount: result.candidatesTokenCount,
      textLength: result.text.length,
      textPreview: result.text.slice(0, 200),
    };
  } catch (err) {
    report.gemini = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return Response.json(report, { status: 200 });
}
