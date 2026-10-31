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
    const speed = Math.max(0.8, Math.min(1.25, Number(body.speed) || 1));
    // 고를 수 있는 목소리 (앱의 '목소리 고르기'와 같은 목록)
    const VOICES = ["coral", "nova", "sage", "shimmer", "alloy"];
    const voice = VOICES.includes(body.voice) ? body.voice : (process.env.OPENAI_TTS_VOICE || "coral");
    if (!text) return res.status(400).json({ error: "no_text" });

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: voice,
        input: text,
        // [수정] 예전 지시("천천히, 또박또박, 문장 사이 쉬기")가 어색한 끊김을 만들었음
        //        → 친절한 해설사가 옆에서 말해 주듯 자연스럽게, 보통 속도
        instructions: "서울말을 쓰는 한국어 원어민 해설사가 옆 사람에게 말하듯 자연스럽게 말해요. " +
          "보통 속도로, 문장을 끊지 말고 이어서 매끄럽게. 따뜻하고 친절한 말투. " +
          "감정은 '" + emotion + "'을 살짝만 담고 과장하지 않아요.",
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
