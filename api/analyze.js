// =====================================================================
// api/analyze.js — Vercel 서버 함수 (휴대폰이 아니라 Vercel의 컴퓨터에서 실행됨)
//
// 하는 일 (계획서의 흐름 그대로):
//   1) Original to Text : 사진·장면·소리 정보 → 쉬운 해설 + 해석(장면별)   [창의성 중간]
//   2) 규칙 검사기      : 쉬운 말 규칙을 지켰는지 코드로 세어 봄 → 어기면 다시 쓰게 함
//   3) Text to Sense    : 쉬운 해설 → 감각 신호표(감정·세기·빠르기·색·높낮이·질감) [창의성 낮게]
//                         장면마다 '왜 그 감각인지' 근거를 남김. 장면끼리 똑같으면 다시 만들게 함
//
// API 키는 코드에 적지 않습니다. Vercel 금고(환경 변수 OPENAI_API_KEY)에서 꺼내 씁니다.
// =====================================================================

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// 사용할 AI 모델 (앞에서부터 시도). Vercel 환경 변수 OPENAI_MODEL로 바꿀 수 있음
const MODELS = [process.env.OPENAI_MODEL, "gpt-4o-mini", "gpt-5-mini"].filter(Boolean);

// 쉬운 말 규칙 (CEFR A1/A2의 능력 기준을 한국어 쉬운 글 규칙으로 응용)
const RULES = { maxWords: 12, maxSummaryWords: 15, minScenes: 2, maxScenes: 5 };

// 어려운 낱말 목록 (시작용). 팀원 A가 CACD 작업하며 늘려 갈 목록
const HARD_WORDS = [
  "구도", "원근", "채도", "명도", "명암", "질감", "상징", "추상", "표현주의", "인상주의",
  "사실주의", "서사", "내면", "정체성", "모티프", "조형", "미학", "대비를 이루", "형상화",
  "은유", "함축", "역동적", "정적인", "몽환적", "서정적", "비장", "해학", "풍자", "조화를 이루"
];

const TEMPOS = ["느림", "보통", "빠름"];
const PITCHES = ["낮음", "중간", "높음"];
const TEXTURES = ["부드러움", "물결", "톡톡", "거침", "묵직함"];

// ---------------------------------------------------------------------
// 간단한 사용량 제한: 같은 인터넷 주소에서 10분에 60번까지
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
// 1) Original to Text 지시문
// ---------------------------------------------------------------------
function textPrompt(type, explain, target) {
  const perScene = explain === "short" ? 1 : 2;
  const what = {
    photo: "사용자가 휴대폰 카메라로 찍은 사진 1장",
    video: "사용자가 휴대폰으로 담은 영상에서 시간 순서대로 뽑은 장면 사진 여러 장과 소리 정보",
    sound: "소리를 기기에서 분석한 숫자 정보(크기·변화·높낮이·강세). 실제 소리는 듣지 못했으니 추측임을 밝힌다"
  }[type];

  return [
    "너는 인지적 약자(경계선 지능인 등)를 위한 문화예술 해설가다.",
    "입력: " + what + ".",
    target
      ? "사용자가 고른 대상: '" + target + "'. 이 대상만 해설한다."
      : (type === "photo"
        ? "먼저 사진 속에서 '느껴볼 대상'을 정한다. 뚜렷한 중심 대상이 하나면 그것을 고른다. " +
          "서로 다른 대상이 2개 이상 비슷한 크기로 있어 무엇을 골라야 할지 정말 모르겠을 때만 needs_choice를 true로 하고 candidates를 채운다."
        : ""),
    "",
    "[무엇을 쓸까]",
    "- kind: 찍힌 대상의 종류. 카메라로 찍었다고 '사진'이라고 하지 않는다. (그림, 조각, 사진작품, 포스터, 공연·무대, 영상 화면, 건축, 공예, 책, 음악, 일상 물건, 기타)",
    "- is_artwork: 문화예술 작품이면 true, 일상 물건·풍경이면 false. false여도 그 장면의 분위기와 느낌을 해설한다.",
    "- summary: 무엇인지 + 첫 느낌을 1문장으로.",
    "- interpretation: 이 작품(장면)이 주는 느낌이나 이야기를 1~2문장으로 해석한다. 보이는 것을 늘어놓지 말고, '어떤 마음이 드는지', '무엇을 말하는 것 같은지'를 쓴다.",
    "- scenes: 감상하기 좋게 " + RULES.minScenes + "~" + RULES.maxScenes + "개로 나눈다. 각 장면은 '무엇이 있는지 + 어떤 느낌인지'를 함께 쓴다.",
    type === "photo"
      ? "- 사진이면 각 장면이 사진 어디에 있는지 box에 [왼쪽, 위, 오른쪽, 아래]를 0~1000 좌표로 쓴다."
      : "- box는 null로 둔다.",
    type === "video" ? "- 영상은 '무엇이 일어나는지'를 말한다. '보여요', '보여줘요'를 반복하지 않는다." : "",
    "",
    "[쉬운 말 규칙 — 반드시 지킬 것]",
    "1. 한 문장은 " + RULES.maxWords + "어절 이하. 한 문장에 정보 하나만.",
    "2. 장면마다 " + perScene + "문장 이하. summary는 1문장 " + RULES.maxSummaryWords + "어절 이하. interpretation은 2문장 이하.",
    "3. 초등학생도 아는 낱말만. 미술·음악 전문 용어(구도, 질감, 명암, 상징 등)는 쓰지 않는다.",
    "4. 느낌은 일상 물건이나 몸의 느낌으로 비유한다. (예: '이불 속처럼 포근해요')",
    "5. 주어를 분명히, '~요'로 끝나는 부드러운 존댓말.",
    "",
    "[정직 규칙]",
    "- 작품 이름은 확실할 때만 title_guess에, 아니면 빈 문자열.",
    "- 확실하지 않은 해석은 '~같아요'로 쓴다. 지어내지 않는다.",
    "- 사람이 보이면 누구인지 추측하지 않고, 얼굴 생김새를 자세히 묘사하지 않는다.",
    "",
    "[좋은 예 — 밤하늘 그림]",
    '{"kind":"그림","is_artwork":true,"title_guess":"","needs_choice":false,"candidates":[],',
    ' "summary":"밤하늘이 빙글빙글 도는 그림이에요.",',
    ' "interpretation":"조용한 마을 위로 하늘이 크게 움직여요. 잠 못 드는 밤의 설레는 마음 같아요.",',
    ' "scenes":[{"name":"하늘","text":"하늘이 소용돌이처럼 돌아요. 바람이 크게 부는 것 같아요.","box":[0,0,1000,550]},',
    '           {"name":"별","text":"노란 별이 반짝여요. 작은 등불처럼 따뜻해요.","box":[100,50,950,350]},',
    '           {"name":"마을","text":"마을은 조용히 잠들어 있어요.","box":[200,650,1000,1000]}]}',
    "",
    "[출력] 위와 같은 모양의 JSON만 출력한다. needs_choice가 true면 candidates에 [{\"name\":\"\",\"box\":[..]}]를 2~4개 쓴다."
  ].filter((x) => x !== "").join("\n");
}

// ---------------------------------------------------------------------
// 3) Text to Sense 지시문 — 예시 값을 주지 않음 (예전에 AI가 예시 값을 그대로 베꼈음)
// ---------------------------------------------------------------------
function sensePrompt() {
  return [
    "너는 문화 콘텐츠의 해설을 시각·청각·촉각 신호로 바꾸는 설계자다.",
    "입력: 콘텐츠 종류, 요약, 해석, 장면별 쉬운 해설, (있으면) 기기가 분석한 소리 정보.",
    "할 일: 전체(whole)와 장면마다 감각 신호표를 만든다.",
    "",
    "[값의 종류]",
    "- emotion: 그 장면의 감정을 한 낱말로",
    "- intensity: 0.1~0.95 사이의 숫자. 조용하고 약하면 낮게, 강하고 극적이면 높게",
    "- tempo: " + TEMPOS.join(" | "),
    "- colors: 그 장면을 대표하는 실제 색 1~3개 (#RRGGBB)",
    "- pitch: " + PITCHES.join(" | "),
    "- texture: " + TEXTURES.join(" | ") + "  (진동으로 느낄 촉감)",
    "- why: 왜 이렇게 정했는지 15자 안팎의 짧은 근거",
    "",
    "[정하는 기준 — 사람들이 감각을 연결하는 일반적인 경향(교차감각 대응)]",
    "- 밝고 가볍고 작은 것 → 높은 소리, 밝은 색, 톡톡 / 어둡고 크고 무거운 것 → 낮은 소리, 짙은 색, 묵직함",
    "- 움직임·긴장·흥분 → 빠름, 강하게 / 고요·잠·휴식 → 느림, 약하게, 부드러움",
    "- 흐르고 감기는 것(물, 바람, 소용돌이) → 물결 / 울퉁불퉁·거친 표면·소란 → 거침",
    "",
    "[중요]",
    "- 입력의 내용에 맞춰 값을 정한다. 아무 근거 없이 중간값(보통, 중간, 0.5)을 고르지 않는다.",
    "- 장면마다 느낌이 다르면 값도 분명히 다르게 한다. 정말 같을 때만 같게 한다.",
    "- 장면 순서와 개수는 입력과 똑같이.",
    "",
    '[출력] JSON만: {"whole":{...}, "scenes":[{...}, ...]}  (각 {...}는 위 7가지 값을 모두 가짐)'
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
      return { data: JSON.parse(content || "{}"), model: model };
    }
    const code = j.error && j.error.code;
    lastErr = { status: r.status, code: code, message: j.error && j.error.message };
    if (r.status === 404 || code === "model_not_found") continue;   // 모델이 없을 때만 다음 모델로
    break;
  }
  throw lastErr || { status: 500, message: "unknown" };
}

// ---------------------------------------------------------------------
// 2) 규칙 검사기
// ---------------------------------------------------------------------
function sentencesOf(text) {
  return String(text || "").split(/[.!?…]+/).map((s) => s.trim()).filter(Boolean);
}
const wordsOf = (s) => s.split(/\s+/).filter(Boolean).length;

function checkRules(d, explain, type) {
  const v = [];
  const perScene = explain === "short" ? 1 : 2;
  const sum = sentencesOf(d.summary);
  if (sum.length !== 1) v.push("summary가 " + sum.length + "문장이에요 (1문장)");
  sum.forEach((s) => { if (wordsOf(s) > RULES.maxSummaryWords) v.push("summary가 " + wordsOf(s) + "어절이에요 (" + RULES.maxSummaryWords + "어절 이하)"); });
  const itp = sentencesOf(d.interpretation);
  if (itp.length === 0) v.push("interpretation(해석)이 없어요");
  if (itp.length > 2) v.push("interpretation이 " + itp.length + "문장이에요 (2문장 이하)");
  itp.forEach((s) => { if (wordsOf(s) > RULES.maxWords) v.push("interpretation에 " + wordsOf(s) + "어절 문장이 있어요 (" + RULES.maxWords + "어절 이하)"); });

  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  if (scenes.length < RULES.minScenes || scenes.length > RULES.maxScenes) {
    v.push("장면이 " + scenes.length + "개예요 (" + RULES.minScenes + "~" + RULES.maxScenes + "개)");
  }
  scenes.forEach((sc, i) => {
    const ss = sentencesOf(sc.text);
    if (ss.length > perScene) v.push((i + 1) + "번 장면이 " + ss.length + "문장이에요 (" + perScene + "문장 이하)");
    ss.forEach((s) => { if (wordsOf(s) > RULES.maxWords) v.push((i + 1) + "번 장면에 " + wordsOf(s) + "어절 문장이 있어요 (" + RULES.maxWords + "어절 이하)"); });
  });
  const all = [d.summary, d.interpretation].concat(scenes.map((s) => s.text)).join(" ");
  HARD_WORDS.forEach((w) => { if (all.includes(w)) v.push("어려운 낱말 '" + w + "'을 썼어요"); });
  if (type === "video" && (all.match(/보여/g) || []).length > 2) v.push("'보여요/보여줘요'를 너무 많이 썼어요. 무엇이 일어나는지를 말해 주세요");
  if (/^사진$/.test(String(d.kind || ""))) v.push("kind를 '사진'이라고 했어요. 찍힌 대상의 종류를 써 주세요");
  return v;
}

function stats(d) {
  const ss = [].concat(sentencesOf(d.summary), sentencesOf(d.interpretation), ...(d.scenes || []).map((s) => sentencesOf(s.text)));
  const w = ss.map(wordsOf);
  return {
    sentences: ss.length,
    avgWords: w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1) : 0,
    maxWords: w.length ? Math.max(...w) : 0
  };
}

// 감각표 검사: 빠진 값을 채우고, 장면끼리 전부 똑같으면 알려 줌
function cleanSense(s) {
  s = s || {};
  const num = Number(s.intensity);
  return {
    emotion: String(s.emotion || "평온").slice(0, 12),
    intensity: isFinite(num) ? Math.max(0.1, Math.min(0.95, num)) : 0.5,
    tempo: TEMPOS.includes(s.tempo) ? s.tempo : "보통",
    colors: (Array.isArray(s.colors) ? s.colors : []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3),
    pitch: PITCHES.includes(s.pitch) ? s.pitch : "중간",
    texture: TEXTURES.includes(s.texture) ? s.texture : "부드러움",
    why: String(s.why || "").slice(0, 40)
  };
}
function senseProblems(d, n) {
  const v = [];
  const sc = (d.scenes || []).map(cleanSense);
  if (sc.length !== n) v.push("장면 수가 " + n + "개여야 해요");
  if (sc.length >= 2) {
    const key = (s) => [s.intensity, s.tempo, s.pitch, s.texture].join("|");
    if (sc.every((s) => key(s) === key(sc[0]))) v.push("모든 장면의 값이 똑같아요. 장면마다 느낌에 맞게 다르게 정해 주세요");
  }
  return v;
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
    const target = String(body.target || "").slice(0, 30);
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
      { role: "system", content: textPrompt(type, explain, target) },
      { role: "user", content: userParts }
    ];
    const tText = Date.now();
    const first = await callAI(msgs, 0.6);      // 해설은 창의성 '중간'
    let text = first.data;

    // 대상이 여러 개라 골라야 할 때 → 여기서 멈추고 사용자에게 물어봄
    if (type === "photo" && !target && text.needs_choice && Array.isArray(text.candidates) && text.candidates.length >= 2) {
      return res.status(200).json({
        ok: true, needs_choice: true, model: first.model,
        candidates: text.candidates.slice(0, 4).map((c) => ({ name: String(c.name || "").slice(0, 20), box: c.box || null })),
        ms: { text: Date.now() - tText, sense: 0, total: Date.now() - t0 }
      });
    }

    // ---------- 2) 규칙 검사기 → 어기면 한 번 고쳐 쓰게 함 ----------
    let violations = checkRules(text, explain, type);
    let tries = 1;
    if (violations.length) {
      const fix = await callAI(msgs.concat([
        { role: "assistant", content: JSON.stringify(text) },
        { role: "user", content: "다음 규칙을 어겼어요. 같은 모양의 JSON으로 고쳐 주세요:\n- " + violations.join("\n- ") }
      ]), 0.4);
      const v2 = checkRules(fix.data, explain, type);
      tries = 2;
      if (v2.length <= violations.length) { text = fix.data; violations = v2; }
    }
    const textMs = Date.now() - tText;

    // ---------- 3) Text to Sense ----------
    const tSense = Date.now();
    const scenes = (text.scenes || []).slice(0, RULES.maxScenes);
    const senseIn = "종류: " + text.kind + "\n요약: " + text.summary + "\n해석: " + text.interpretation + "\n" +
      scenes.map((s, i) => "장면 " + (i + 1) + " (" + s.name + "): " + s.text).join("\n") + "\n" + audioText(body.audio);
    const senseMsgs = [{ role: "system", content: sensePrompt() }, { role: "user", content: senseIn }];
    let sense = await callAI(senseMsgs, 0.1);   // 감각 신호표는 창의성 '낮게'
    let sProblems = senseProblems(sense.data, scenes.length);
    let senseTries = 1;
    if (sProblems.length) {
      const fix = await callAI(senseMsgs.concat([
        { role: "assistant", content: JSON.stringify(sense.data) },
        { role: "user", content: "고쳐 주세요:\n- " + sProblems.join("\n- ") }
      ]), 0.3);
      senseTries = 2;
      const p2 = senseProblems(fix.data, scenes.length);
      if (p2.length <= sProblems.length) { sense = fix; sProblems = p2; }
    }
    const senseMs = Date.now() - tSense;

    const sScenes = sense.data.scenes || [];
    return res.status(200).json({
      ok: true,
      model: first.model,
      kind: text.kind || "기타",
      is_artwork: !!text.is_artwork,
      title_guess: text.title_guess || "",
      target: target,
      summary: text.summary || "",
      interpretation: text.interpretation || "",
      whole: cleanSense(sense.data.whole),
      scenes: scenes.map((s, i) => ({ name: s.name, text: s.text, box: Array.isArray(s.box) ? s.box : null, sense: cleanSense(sScenes[i]) })),
      check: { passed: violations.length === 0, violations: violations, tries: tries, stats: stats(text),
               sensePassed: sProblems.length === 0, senseProblems: sProblems, senseTries: senseTries },
      ms: { text: textMs, sense: senseMs, total: Date.now() - t0 }
    });
  } catch (e) {
    const status = e && e.status;
    const error = status === 401 ? "bad_key" : status === 429 ? "quota_or_rate" : "ai_error";
    return res.status(status === 401 || status === 429 ? status : 500).json({ error: error, detail: e && e.message });
  }
};
