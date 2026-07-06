export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.6 }}>
      <h1>Arayatime LINE Bot</h1>
      <p>ระบบตอบ FAQ อัตโนมัติผ่าน LINE + Google Gemini</p>
      <p>
        Webhook endpoint: <code>/api/line-webhook</code>
      </p>
    </main>
  );
}
