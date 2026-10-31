// =====================================================================
// api/analyze.js — Vercel 서버 함수 (휴대폰이 아니라 Vercel의 컴퓨터에서 실행됨)
//
// 하는 일 (계획서의 흐름 그대로):
//   1) Original to Text : 사진·장면·소리 정보 → 쉬운 해설(장면별)   [창의성 중간]
//   2) 규칙 검사기      : 쉬운 말 규칙을 지켰는지 코드로 세어 봄 → 어기면 1번 다시 쓰게 함
//   3) Text to Sense    : 쉬운 해설 → 감각 신호표(감정·세기·빠르기·색·높낮이·질감) [창의성 낮게]
//
// API 키는 코드에 적지 않습니다. Vercel 금고(환경 변수 OPENAI_API_KEY)에서 꺼내 씁니다.
// =====================================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// 사용할 AI 모델 (앞에서부터 시도). Vercel 환경 변수 OPENAI_MODEL로 바꿀 수 있음
const MODELS = [process.env.OPENAI_MODEL, "gpt-4o-mini", "gpt-5-mini"].filter(Boolean);

// 쉬운 말 규칙 (CEFR A1/A2의 능력 기준을 한국어 쉬운 글 규칙으로 응용)
const RULES = {
  maxWords: 12,          // 한 문장 최대 어절 수
  maxSummaryWords: 15,   // 요약 한 문장 최대 어절 수
  minScenes: 2,
  maxScenes: 5
};

// 어려운 낱말 목록 (시작용). 팀원 A가 CACD 작업하며 늘려 갈 목록
const HARD_WORDS = [
  "구도", "원근", "채도", "명도", "명암", "질감", "상징", "추상", "표현주의", "인상주의",
  "사실주의", "서사", "내면", "정체성", "모티프", "조형", "미학", "대비를 이루", "형상화",
  "은유", "함축", "역동적", "정적인", "몽환적", "서정적", "비장", "해학", "풍자", "조화를 이루"
];

// ---------------------------------------------------------------------
// 간단한 사용량 제한: 같은 인터넷 주소에서 10분에 60번까지
// (부스 와이파이는 여러 사람이 같은 주소를 쓰므로 넉넉하게)
// ---------------------------------------------------------------------
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 60;
}

// ---------------------------------------------------------------------
// 지시문(프롬프트)
// ---------------------------------------------------------------------
function textPrompt(type, explain) {
  const perScene = explain === "short" ? 1 : 2;
  const what = {
    photo: "사진 1장",
    video: "영상에서 시간 순서대로 뽑은 장면 사진 여러 장과 소리 정보",
    sound: "소리를 기기에서 분석한 숫자 정보(크기·변화·높낮이·강세). 이것만 보고 분위기를 추측해야 함"
  }[type];

  return [
    "너는 인지적 약자(경계선 지능인 등)를 위한 문화예술 해설가다.",
    "입력: " + what + ".",
    "할 일: 이 문화 콘텐츠를 아주 쉬운 한국어로 설명하고, 감상하기 좋게 장면으로 나눈다.",
    "",
    "[쉬운 말 규칙 — 반드시 지킬 것]",
    "1. 한 문장은 " + RULES.maxWords + "어절 이하. 한 문장에 정보 하나만.",
    "2. 장면마다 " + perScene + "문장 이하.",
    "3. 요약(summary)은 1문장, " + RULES.maxSummaryWords + "어절 이하.",
    "4. 초등학생도 아는 낱말만 쓴다. 미술·음악 전문 용어(구도, 질감, 명암, 상징 등)는 쓰지 않는다.",
    "5. 어려운 느낌은 일상 물건이나 몸의 느낌으로 비유한다. (예: '솜사탕처럼 부드러워요')",
    "6. 주어를 분명히 쓰고, '~요'로 끝나는 부드러운 존댓말을 쓴다.",
    "",
    "[정직 규칙]",
    "- 작품 이름은 확실할 때만 title_guess에 쓰고, 아니면 빈 문자열.",
    "- 확실하지 않은 내용은 '~같아요'로 쓴다. 지어내지 않는다.",
    "- 사람이 보이면 누구인지 추측하지 말고, 얼굴 생김새도 자세히 묘사하지 않는다.",
    "",
    "[장면 나누기]",
    "- 장면은 " + RULES.minScenes + "~" + RULES.maxScenes + "개. 그림·사진은 화면 속 부분별로, 영상은 시간 흐름이나 중요한 대상별로.",
    type === "photo"
      ? "- 사진이면 각 장면이 사진 어디에 있는지 box에 [왼쪽, 위, 오른쪽, 아래]를 0~1000 좌표로 쓴다."
      : "- box는 null로 둔다.",
    "",
    "[출력] 아래 모양의 JSON만 출력한다. 다른 글은 쓰지 않는다.",
    '{"kind":"그림|조각|사진|포스터|영상|공연|음악|기타", "title_guess":"", "confidence":0.0~1.0,',
    ' "summary":"한 문장 요약",',
    ' "scenes":[{"name":"짧은 이름(2~4글자)", "text":"쉬운 해설", "box":[0,0,1000,1000] 또는 null}]}'
  ].join("\n");
}

function sensePrompt() {
  return [
    "너는 문화 콘텐츠의 해설을 시각·청각·촉각 신호로 바꾸는 설계자다.",
    "입력: 콘텐츠 종류, 요약, 장면별 쉬운 해설, (있으면) 기기가 분석한 소리 정보.",
    "할 일: 전체(whole)와 장면마다 감각 신호표를 만든다.",
    "",
    "[값 규칙]",
    '- emotion: 한 낱말 (예: "신비로움", "설렘", "슬픔", "평온", "긴장", "기쁨")',
    "- intensity: 0~1 (감정·자극의 세기)",
    '- tempo: "느림" | "보통" | "빠름"',
    "- colors: 그 장면을 대표하는 색 1~3개, #RRGGBB",
    '- pitch: "낮음" | "중간" | "높음" (그 장면에 어울리는 소리 높이)',
    '- texture: "부드러움" | "물결" | "톡톡" | "거침" | "묵직함" 중 하나 (그 장면에 어울리는 진동 느낌)',
    "- 장면 순서와 개수는 입력과 똑같이.",
    "",
    "[출력] JSON만:",
    '{"whole":{"emotion":"","intensity":0.5,"tempo":"보통","colors":["#000000"],"pitch":"중간","texture":"부드러움"},',
    ' "scenes":[{"emotion":"","intensity":0.5,"tempo":"보통","colors":["#000000"],"pitch":"중간","texture":"부드러움"}]}'
  ].join("\n");
}

function audioText(a) {
  if (!a) return "소리 정보: 없음";
  return "소리 정보(기기 분석): 크기 " + a.loud + ", " + a.change + ", " + a.pitch +
    ", 강세 " + a.accents + "번" + (a.bpm ? ", 빠르기 약 " + a.bpm + " BPM" : "") +
    ", 길이 " + Number(a.sec).toFixed(0) + "초";
}

// ---------------------------------------------------------------------
// OpenAI 부르기 (모델을 앞에서부터 시도)
// ---------------------------------------------------------------------
async function callAI(messages, temperature) {
  let lastErr = null;
  for (const model of MODELS) {
    const isReasoning = /^gpt-5|^o\d/.test(model);
    const payload = { model: model, messages: messages, response_format: { type: "json_object" } };
    if (isReasoning) {
      payload.max_completion_tokens = 4000;     // 이 계열은 창의성 값(temperature)을 바꿀 수 없음
    } else {
      payload.max_tokens = 1500;
      payload.temperature = temperature;
    }
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return { data: JSON.parse(content || "{}"), model: model, usage: j.usage || null };
    }
    const code = j.error && j.error.code;
    lastErr = { status: r.status, code: code, message: j.error && j.error.message };
    // 모델이 없을 때만 다음 모델로. 키·충전 문제는 바로 멈춤
    if (r.status === 404 || code === "model_not_found") continue;
    break;
  }
  throw lastErr || { status: 500, message: "unknown" };
}

// ---------------------------------------------------------------------
// 규칙 검사기: 쉬운 말 규칙을 코드로 세어 봄
// ---------------------------------------------------------------------
function sentencesOf(text) {
  return String(text || "").split(/[.!?…]+/).map((s) => s.trim()).filter(Boolean);
}
const wordsOf = (s) => s.split(/\s+/).filter(Boolean).length;

function checkRules(d, explain) {
  const v = [];
  const perScene = explain === "short" ? 1 : 2;
  const sum = sentencesOf(d.summary);
  if (sum.length !== 1) v.push("요약이 " + sum.length + "문장이에요 (1문장이어야 해요)");
  sum.forEach((s) => { if (wordsOf(s) > RULES.maxSummaryWords) v.push("요약이 " + wordsOf(s) + "어절이에요 (" + RULES.maxSummaryWords + "어절 이하)"); });

  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  if (scenes.length < RULES.minScenes || scenes.length > RULES.maxScenes) {
    v.push("장면이 " + scenes.length + "개예요 (" + RULES.minScenes + "~" + RULES.maxScenes + "개)");
  }
  scenes.forEach((sc, i) => {
    const ss = sentencesOf(sc.text);
    if (ss.length > perScene) v.push((i + 1) + "번 장면이 " + ss.length + "문장이에요 (" + perScene + "문장 이하)");
    ss.forEach((s) => { if (wordsOf(s) > RULES.maxWords) v.push((i + 1) + "번 장면에 " + wordsOf(s) + "어절 문장이 있어요 (" + RULES.maxWords + "어절 이하)"); });
  });
  const all = [d.summary].concat(scenes.map((s) => s.text)).join(" ");
  HARD_WORDS.forEach((w) => { if (all.includes(w)) v.push("어려운 낱말 '" + w + "'을 썼어요"); });
  return v;
}

// 숫자 통계 (원문 대비가 아니라 결과 자체의 쉬움 지표)
function stats(d) {
  const ss = [].concat(sentencesOf(d.summary), ...(d.scenes || []).map((s) => sentencesOf(s.text)));
  const w = ss.map(wordsOf);
  return {
    sentences: ss.length,
    avgWords: w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1) : 0,
    maxWords: w.length ? Math.max(...w) : 0
  };
}

// ---------------------------------------------------------------------
// 요청 처리
// ---------------------------------------------------------------------
module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST만 받아요" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "no_key" });

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "local";
    if (tooMany(ip)) return res.status(429).json({ error: "too_many" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const type = ["photo", "video", "sound"].includes(body.type) ? body.type : "photo";
    const explain = body.explain === "short" ? "short" : "normal";
    const images = (Array.isArray(body.images) ? body.images : [])
      .filter((s) => typeof s === "string" && s.startsWith("data:image/") && s.length < 2000000)
      .slice(0, 8);
    if (type !== "sound" && images.length === 0) return res.status(400).json({ error: "no_image" });

    // ---------- 1) Original to Text ----------
    const userParts = [{ type: "text", text: (type === "video" ? "장면 사진은 시간 순서예요. " : "") + audioText(body.audio) }];
    images.forEach((url) => userParts.push({
      type: "image_url",
      image_url: { url: url, detail: type === "photo" ? "auto" : "low" }   // 영상 장면은 저해상도로 (빠르고 저렴)
    }));
    const msgs = [
      { role: "system", content: textPrompt(type, explain) },
      { role: "user", content: userParts }
    ];
    const tText = Date.now();
    let first = await callAI(msgs, 0.6);      // 해설은 창의성 '중간'
    let text = first.data;
    let violations = checkRules(text, explain);
    let tries = 1;

    // ---------- 2) 규칙 검사기 → 어기면 한 번 고쳐 쓰게 함 ----------
    if (violations.length) {
      const fix = await callAI(msgs.concat([
        { role: "assistant", content: JSON.stringify(text) },
        { role: "user", content: "다음 규칙을 어겼어요. 같은 모양의 JSON으로 고쳐 주세요:\n- " + violations.join("\n- ") }
      ]), 0.4);
      const v2 = checkRules(fix.data, explain);
      tries = 2;
      if (v2.length <= violations.length) { text = fix.data; violations = v2; }
    }
    const textMs = Date.now() - tText;

    // ---------- 3) Text to Sense ----------
    const tSense = Date.now();
    const scenes = (text.scenes || []).slice(0, RULES.maxScenes);
    const senseIn = "종류: " + text.kind + "\n요약: " + text.summary + "\n" +
      scenes.map((s, i) => "장면 " + (i + 1) + " (" + s.name + "): " + s.text).join("\n") + "\n" + audioText(body.audio);
    const sense = await callAI([
      { role: "system", content: sensePrompt() },
      { role: "user", content: senseIn }
    ], 0.1);                                  // 감각 신호표는 창의성 '낮게'
    const senseMs = Date.now() - tSense;

    const sScenes = (sense.data.scenes || []);
    return res.status(200).json({
      ok: true,
      model: first.model,
      kind: text.kind || "기타",
      title_guess: text.title_guess || "",
      confidence: typeof text.confidence === "number" ? text.confidence : 0.5,
      summary: text.summary || "",
      whole: sense.data.whole || null,
      scenes: scenes.map((s, i) => Object.assign({ name: s.name, text: s.text, box: s.box || null }, { sense: sScenes[i] || null })),
      check: { passed: violations.length === 0, violations: violations, tries: tries, stats: stats(text) },
      ms: { text: textMs, sense: senseMs, total: Date.now() - t0 }
    });
  } catch (e) {
    const status = e && e.status;
    const error = status === 401 ? "bad_key" : status === 429 ? "quota_or_rate" : "ai_error";
    return res.status(status === 401 || status === 429 ? status : 500).json({ error: error, detail: e && e.message });
  }
};
