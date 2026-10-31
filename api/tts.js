// =====================================================================
// api/tts.js — GPT 음성 만들기 (Vercel 서버 함수)
// 쉬운 해설 글 → 차분하고 따뜻한 목소리의 mp3
// API 키는 Vercel 금고(OPENAI_API_KEY)에서 꺼내 씀
// =====================================================================

const hits = new Map();   // 같은 인터넷 주소에서 10분에 120번까지
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 120;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST만 받아요" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "no_key" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "local";
    if (tooMany(ip)) return res.status(429).json({ error: "too_many" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").slice(0, 500);        // 너무 긴 글은 자름 (비용 보호)
    const emotion = String(body.emotion || "평온").slice(0, 20);
    const speed = Math.max(0.6, Math.min(1.2, Number(body.speed) || 1));
    if (!text) return res.status(400).json({ error: "no_text" });

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: process.env.OPENAI_TTS_VOICE || "coral",
        input: text,
        // 말투 지시: 감정이 지나치면 오히려 인지 부담이 커지므로 '은은하게'
        instructions: "자연스러운 한국어 원어민처럼 말해요. 차분하고 따뜻한 목소리로, 또박또박 천천히. " +
          "감정은 '" + emotion + "'을 은은하게만 담고, 과장하지 않아요. 문장 사이에 짧게 쉬어요.",
        response_format: "mp3",
        speed: speed
      })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const error = r.status === 401 ? "bad_key" : r.status === 429 ? "quota_or_rate" : "tts_error";
      return res.status(r.status).json({ error: error, detail: j.error && j.error.message });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: "tts_error", detail: e && e.message });
  }
};
