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
const SERVER_VERSION = "6-3";   // 앱 '개발용 정보'에 표시됨 → 새 코드가 올라갔는지 확인용

// 사용할 AI 모델 (앞에서부터 시도). Vercel 환경 변수 OPENAI_MODEL로 바꿀 수 있음
const MODELS = [process.env.OPENAI_MODEL, "gpt-4o-mini", "gpt-5-mini"].filter(Boolean);

// 쉬운 말 규칙 (CEFR A1/A2의 능력 기준을 한국어 쉬운 글 규칙으로 응용)
const RULES = { maxWords: 12, maxSummaryWords: 15, minScenes: 2, maxScenes: 5 };
const GRID = 8;   // 사진 위에 그린 번호 칸: 8×8 = 64칸 (6×6보다 촘촘)

// 어려운 낱말 목록 (시작용). 팀원 A가 CACD 작업하며 늘려 갈 목록
const HARD_WORDS = [
  "구도", "원근", "채도", "명도", "명암", "질감", "상징", "추상", "표현주의", "인상주의",
  "사실주의", "서사", "내면", "정체성", "모티프", "조형", "미학", "대비를 이루", "형상화",
  "은유", "함축", "역동적", "정적인", "몽환적", "서정적", "비장", "해학", "풍자", "조화를 이루"
];

// 평가하는 말 (근거 없이 좋다·나쁘다를 정해 버리는 말) — 쉬운 정보에서는 피함
const JUDGE_WORDS = ["멋지", "멋진", "아름다", "아름답", "훌륭", "대단", "예쁘", "예쁜", "완벽", "걸작", "명작", "최고"];

// [수정 6-3] 해석하는 말 — 해설은 '보이는 것'만. 느낌·마음·이야기는 관객의 몫
const FEEL_WORDS = ["같아요", "같은 느낌", "느껴", "느낌", "기분", "마음", "분위기", "행복", "즐거", "슬픈", "슬퍼", "무서", "외로", "신나", "설레", "포근", "것 같", "듯해", "듯이"];
// 흑백 사진에서 쓰면 안 되는 색 낱말 (흰·검은·회색은 괜찮음)
const COLOR_WORDS = ["빨간", "빨강", "붉은", "파란", "파랑", "푸른", "노란", "노랑", "초록", "녹색", "분홍", "보라", "주황", "갈색", "금빛", "황금", "화려한 색", "알록달록", "색깔", "컬러", "다채로운 색"];

const TEMPOS = ["느림", "보통", "빠름"];
const PITCHES = ["낮음", "중간", "높음"];
const TEXTURES = ["부드러움", "물결", "톡톡", "거침", "묵직함"];
const MODES = ["밝음", "신남", "차분함", "슬픔", "신비", "긴장"];   // (이제 숫자에서 코드가 계산하는 이름표)

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
function textPrompt(type, explain, target, cropped, pixel) {
  const perScene = explain === "short" ? 1 : 2;
  const what = {
    photo: "사용자가 휴대폰 카메라로 찍은 사진 1장",
    video: "사용자가 휴대폰으로 담은 영상에서 시간 순서대로 뽑은 장면 사진 여러 장과 소리 정보",
    sound: "소리를 기기에서 분석한 숫자 정보(크기·변화·높낮이·강세). 실제 소리는 듣지 못했으니 추측임을 밝힌다"
  }[type];

  return [
    "너는 인지적 약자(경계선 지능인 등)를 위한 문화예술 해설가다.",
    "입력: " + what + "." + (cropped ? "" : ""),
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
    "- summary: 무엇이 보이는지 1문장. (사실만)",
    "- interpretation: 눈에 띄는 모습을 1~2문장 더. 자세·표정·움직임·밝고 어두움·크기처럼 사진에서 확인할 수 있는 것만. (이름은 예전 그대로지만 '해석'이 아니라 '더 자세한 해설'이다)",
    "- scenes: 눈에 띄는 부분 " + RULES.minScenes + "~" + RULES.maxScenes + "개. 각 부분에 '무엇이 어떻게 보이는지'만 쓴다.",
    "- 각 장면의 look: 감각으로 바꿀 재료. 실제로 보이는 색 이름·밝기·크기·움직임·표면을 20자 안팎으로 (사용자에게 보이지 않음. 이 칸은 쉬운 말 규칙 검사를 하지 않음).",
    type === "photo"
      ? "- 사진 위에 1~" + (GRID * GRID) + "번 번호가 적힌 " + GRID + "×" + GRID + " 칸이 그려져 있다. (왼쪽 위가 1번, 한 줄에 " + GRID + "칸씩, 오른쪽 아래가 " + (GRID * GRID) + "번)\n" +
        "  칸과 번호는 위치를 알려 주는 표시일 뿐이니 해설에는 쓰지 않는다.\n" +
        "- frame_cells: 작품(느낄 대상)이 들어 있는 칸 번호를 모두 쓴다. 화면 속 글자·가격·버튼·책상·벽만 있는 칸은 뺀다.\n" +
        "- 각 장면의 cells: 그 장면이 실제로 보이는 칸 번호를 모두 쓴다. 한 칸에 조금이라도 걸치면 넣는다. 장면마다 칸이 달라야 한다."
      : "- cells와 frame_cells는 빈 목록 [] 으로 둔다.",
    type === "video" ? "- 영상은 '무엇이 일어나는지'를 말한다. '보여요', '보여줘요'를 반복하지 않는다." : "",
    "",
    "[쉬운 말 규칙 — 반드시 지킬 것]",
    "1. 한 문장은 " + RULES.maxWords + "어절 이하. 한 문장에 정보 하나만.",
    "2. 장면마다 " + perScene + "문장 이하. summary는 1문장 " + RULES.maxSummaryWords + "어절 이하. interpretation은 2문장 이하.",
    "3. 초등학생도 아는 낱말만. 미술·음악 전문 용어(구도, 질감, 명암, 상징 등)는 쓰지 않는다.",
    "4. 모양·크기는 일상 물건에 빗대어도 된다. (예: '공처럼 동그래요') 마음·느낌에는 빗대지 않는다.",
    "5. 주어를 분명히, '~요'로 끝나는 부드러운 존댓말.",
    "6. '멋진, 아름다운, 훌륭한, 대단한, 예쁜' 같은 평가하는 말을 쓰지 않는다.",
    "7. 느낌·마음·이야기는 쓰지 않는다. 그것은 감상하는 사람이 정한다. '~같아요', '~느껴져요', '행복해요', '즐거운 분위기', '세상을 지켜요'처럼 사진에서 확인할 수 없는 말을 쓰지 않는다.",
    "   (나쁜 예: '아이가 행복해 보여요. 즐거운 분위기예요.' / 좋은 예: '아이가 입을 크게 벌리고 웃어요. 눈은 감고 있어요.')",
    "8. 소리, 냄새, 바람, 온도처럼 사진에 찍히지 않는 것은 쓰지 않는다.",
    "",
    "[정직 규칙]",
    "- 작품 이름은 확실할 때만 title_guess에, 아니면 빈 문자열.",
    "- 보이지 않는 것은 지어내지 않는다. 잘 안 보이면 '잘 보이지 않아요'라고 쓴다.",
    pixel && pixel.gray ? "- 앱이 사진의 픽셀을 직접 재 보니 이 사진은 흑백이다. 빨강·파랑·노랑 같은 색 이름이나 '화려한 색'을 쓰지 않는다. 흰색·검은색·회색, 밝고 어두움만 쓴다." : "",
    pixel && !pixel.gray && pixel.colors && pixel.colors.length ? "- 앱이 픽셀에서 잰 대표 색: " + pixel.colors.join(", ") + ". 색을 말할 때는 실제로 보이는 색만 쓴다." : "",
    "- 사람이 보이면 누구인지 추측하지 않고, 얼굴 생김새를 자세히 묘사하지 않는다.",
    "",
    "[좋은 예 — 밤하늘 그림]",
    '{"kind":"그림","is_artwork":true,"title_guess":"","needs_choice":false,"candidates":[],"frame_cells":[작품이 있는 칸 번호들],',
    ' "summary":"밤하늘과 작은 마을을 그린 그림이에요.",',
    ' "interpretation":"하늘에 소용돌이 모양이 크게 그려져 있어요. 마을은 화면 아래에 작게 있어요.",',
    ' "scenes":[{"name":"하늘","text":"하늘에 굵은 선이 빙글빙글 돌아요.","look":"짙은 파랑, 크게 휘도는 붓질","cells":[하늘이 보이는 칸 번호들]},',
    '           {"name":"별","text":"노란 동그라미 별이 열 개쯤 있어요.","look":"밝은 노랑, 작고 동그란 빛","cells":[별이 있는 칸 번호들]},',
    '           {"name":"마을","text":"작은 집들이 낮게 모여 있어요. 창문에 불빛이 있어요.","look":"어두운 남색, 작고 낮은 지붕들","cells":[마을이 있는 칸 번호들]}]}',
    "",
    "(위 예의 [ ] 안 글은 설명일 뿐이고, 실제로는 칸 번호 숫자들을 쓴다. 사진이 아니면 cells와 frame_cells는 빈 목록)",
    "[출력] 위와 같은 모양의 JSON만 출력한다. needs_choice가 true면 candidates에 [{\"name\":\"\",\"cells\":[칸 번호들]}]를 2~4개 쓴다."
  ].filter((x) => x !== "").join("\n");
}

// ---------------------------------------------------------------------
// 3) Text to Sense 지시문 [수정 4-5]
//    예전: '보통/중간/차분함' 같은 단어를 고르게 함 → AI가 안전한 가운데 단어만 골라 모두 비슷해짐
//    지금: 6가지 느낌을 0~1 숫자로 매기게 하고, 소리·진동·빛으로 바꾸는 일은 '코드'가 함
//    근거: 감정을 '기분(밝음↔어두움)'과 '활기(고요↔흥분)' 두 축으로 보는 감정 모델(러셀의 감정 원형 모델)과
//          밝기·무게·거칠기를 소리 높이·굵기·음색과 연결하는 교차감각 대응 연구
// ---------------------------------------------------------------------
const DIMS = ["valence", "arousal", "brightness", "weight", "roughness", "flow"];
// [수정 6-1] 'C 개선형': 감각 수치를 매기는 AI가 ① 사진을 직접 보고 ② 눈금 예시(기준표)에 맞춰 ③ 3번 매겨 평균
//   예전 구멍: 이 단계 AI가 사진을 못 보고 '쉬운 해설 글'만 받았음 → 색·밝기·질감 정보가 대부분 사라졌음
//   눈금 예시: 0.1 / 0.5 / 0.9가 각각 어떤 모습인지 정해 두어, AI마다·매번 기준이 흔들리지 않게 함 (통제 가능)
const ANCHORS = [
  "valence 기분      0.1 = 장례식, 우는 얼굴, 폐허 / 0.3 = 싸움·고통·슬픔이 보임(이겼더라도) / 0.5 = 평범한 사무실, 무표정, 엄숙한 기념물 / 0.7 = 잔잔한 미소, 맑은 풍경 / 0.9 = 생일 파티, 크게 웃는 아이",
  "arousal 활기      0.1 = 잠든 고양이, 잔잔한 호수 / 0.3 = 가만히 서 있는 조각, 정물 / 0.5 = 천천히 걷는 사람 / 0.7 = 뛰는 아이, 바람에 흔들리는 꽃 / 0.9 = 불꽃놀이, 전투, 격렬한 춤",
  "brightness 밝기   0.1 = 밤하늘, 어두운 동굴, 검은 배경 / 0.5 = 흐린 날 실내 / 0.9 = 눈 덮인 한낮, 흰 벽, 노란 빛",
  "weight 무게       0.1 = 깃털, 비눗방울, 얇은 선 / 0.5 = 의자, 사람 한 명 / 0.9 = 바위, 큰 철 조각상, 산",
  "roughness 거칠기  0.1 = 유리, 비단, 매끈한 대리석 / 0.5 = 나무 책상 / 0.9 = 나무껍질, 두꺼운 붓질, 깨진 돌",
  "flow 흐름         0.1 = 점 찍기, 톡톡 튀는 빗방울, 각진 모양 / 0.5 = 반듯한 직선 / 0.9 = 물결, 소용돌이, 흐르는 천"
];
function sensePrompt() {
  return [
    "너는 문화 콘텐츠의 느낌을 숫자로 재는 측정자다.",
    "입력: 사진(또는 영상 장면 사진), 콘텐츠 종류, 요약, 해석, 장면별 쉬운 해설과 보이는 모습(look), (있으면) 기기가 분석한 소리 정보.",
    "사진을 직접 보고 판단한다. 글은 장면을 찾는 데 참고만 한다.",
    "할 일: 전체(whole)와 장면마다 아래 값을 정한다.",
    "",
    "[0~1 숫자 6가지 — 아래 눈금 예시에 맞춰 매긴다] (소수 둘째 자리까지)",
    ...ANCHORS.map((x) => "- " + x),
    "",
    "[그 밖의 값]",
    "- emotion: 감정 한 낱말",
    "- colors: 사진에서 실제로 보이는 대표 색 1~3개 (#RRGGBB)",
    "- why: 가장 중요한 근거 15자 안팎 (사진에서 본 것)",
    "",
    "[규칙]",
    "- 눈금 예시와 비교해서 가장 가까운 위치를 고른다. 근거 없이 0.5를 고르지 않는다.",
    "- valence(기분)는 '작품이 잘 만들어졌는지'가 아니라 '보이는 장면의 기분'이다. 기쁨이 분명히 보일 때만 0.8 이상.",
    "  싸움, 고통, 죽음, 슬픔이 보이면 이겼거나 영웅적이어도 0.4 아래. 엄숙하거나 무표정이면 0.5 근처.",
    "- arousal(활기)은 움직임이 실제로 보일 때만 높게. 멈춰 있는 조각·정물은 주제가 격해도 0.6을 넘기지 않는다.",
    "- 장면마다 사진에서 그 부분만 보고 매긴다. 장면 순서와 개수는 입력과 똑같이.",
    "- whole은 사진 전체를 처음 봤을 때의 종합적인 느낌이다.",
    "",
    '[출력] JSON만: {"whole":{...}, "scenes":[{...}, ...]}  (각 {...}는 위 9가지 값을 모두 가짐)'
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

function checkRules(d, explain, type, pixel) {
  const v = [];
  const perScene = explain === "short" ? 1 : 2;
  const sum = sentencesOf(d.summary);
  if (sum.length !== 1) v.push("summary가 " + sum.length + "문장이에요 (1문장)");
  sum.forEach((s) => { if (wordsOf(s) > RULES.maxSummaryWords) v.push("summary가 " + wordsOf(s) + "어절이에요 (" + RULES.maxSummaryWords + "어절 이하)"); });
  const itp = sentencesOf(d.interpretation);
  if (itp.length === 0) v.push("interpretation(더 자세한 해설)이 없어요");
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
  JUDGE_WORDS.forEach((w) => { if (all.includes(w)) v.push("평가하는 말 '" + w + "…'을 썼어요. 보이는 모습으로 바꿔 주세요"); });
  FEEL_WORDS.forEach((w) => { if (all.includes(w)) v.push("해석하는 말 '" + w + "'을 썼어요. 느낌은 빼고 보이는 것만 써 주세요"); });
  if (pixel && pixel.gray) COLOR_WORDS.forEach((w) => { if (all.includes(w)) v.push("흑백 사진인데 색 낱말 '" + w + "'을 썼어요. 흰색·검은색·회색, 밝고 어두움으로만 써 주세요"); });
  if (type === "video" && (all.match(/보여/g) || []).length > 2) v.push("'보여요/보여줘요'를 너무 많이 썼어요. 무엇이 일어나는지를 말해 주세요");
  if (/^사진$/.test(String(d.kind || ""))) v.push("kind를 '사진'이라고 했어요. 찍힌 대상의 종류를 써 주세요");
  return v;
}

// 칸 번호 목록 정리: 1~36 정수만, 중복 없이
function cleanCells(c) {
  if (!Array.isArray(c)) return [];
  const out = [];
  c.forEach((v) => { const n = Math.round(Number(v)); if (n >= 1 && n <= GRID * GRID && !out.includes(n)) out.push(n); });
  return out.sort((a, b) => a - b);
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

// 감각표 정리: 숫자는 0~1로 맞추고, 숫자에서 이름표(빠르기·높이·진동 느낌·분위기)를 코드로 계산
const n01 = (v, d) => { const x = Number(v); return isFinite(x) ? Math.max(0, Math.min(1, x)) : d; };
function labelsOf(o) {
  o.tempo = o.arousal < 0.35 ? "느림" : o.arousal < 0.65 ? "보통" : "빠름";
  o.pitch = o.brightness < 0.35 ? "낮음" : o.brightness < 0.65 ? "중간" : "높음";
  o.texture = o.roughness > 0.6 ? "거침" : o.flow > 0.6 ? "물결" : (o.arousal > 0.6 && o.flow < 0.4) ? "톡톡" : o.weight > 0.65 ? "묵직함" : "부드러움";
  o.mode = (o.valence < 0.3 && o.arousal > 0.6) ? "긴장" : o.valence < 0.35 ? "슬픔" :
           (o.flow > 0.65 && o.arousal < 0.5 && o.valence < 0.7) ? "신비" :
           o.valence > 0.6 ? (o.arousal > 0.6 ? "신남" : "밝음") : "차분함";
  o.intensity = +(0.2 + 0.7 * Math.max(o.arousal, o.weight * 0.8)).toFixed(2);   // 자극의 세기 (다음 단계: 스티븐스 법칙)
  return o;
}
function cleanSense(s) {
  s = s || {};
  const o = {
    emotion: String(s.emotion || "평온").slice(0, 12),
    colors: (Array.isArray(s.colors) ? s.colors : []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3),
    why: String(s.why || "").slice(0, 40)
  };
  DIMS.forEach((k) => { o[k] = n01(s[k], 0.5); });
  if (s.spread) o.spread = s.spread;
  return labelsOf(o);
}

// [새로] 장면 간 대비 강조: AI가 장면들을 너무 비슷하게 매기면, 차이를 키워서 감각으로 구분되게 함
//        (차이의 '방향'은 AI 그대로, '크기'만 키움. 몇 배 키웠는지 개발용 정보에 표시)
function spreadScenes(list) {
  const info = {};
  if (list.length < 2) return info;
  DIMS.forEach((k) => {
    const vals = list.map((o) => o[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const range = Math.max(...vals) - Math.min(...vals);
    const want = 0.45;                                 // 장면 사이 차이가 적어도 이 정도는 되게
    const kx = range > 0.02 && range < want ? Math.min(3, want / range) : 1;
    if (kx > 1) list.forEach((o) => { o[k] = +Math.max(0.02, Math.min(0.98, mean + (o[k] - mean) * kx)).toFixed(2); });
    info[k] = +kx.toFixed(2);
  });
  list.forEach(labelsOf);
  return info;
}

// 여러 번 매긴 결과를 평균 (숫자 6가지는 평균, 감정·색·근거는 첫 번째 것)
function averageSense(list, n) {
  const avgOne = (objs) => {
    const cl = objs.map(cleanSense);
    const out = Object.assign({}, objs[0] || {});
    const spread = {};
    DIMS.forEach((k) => {
      const v = cl.map((o) => o[k]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      out[k] = +m.toFixed(2);
      spread[k] = +(v.reduce((a, b) => a + Math.abs(b - m), 0) / v.length).toFixed(3);   // 평균에서 벗어난 정도
    });
    out.spread = spread;
    return out;
  };
  const scenes = [];
  for (let i = 0; i < n; i++) scenes.push(avgOne(list.map((d) => (d.scenes || [])[i] || {})));
  return { whole: avgOne(list.map((d) => d.whole || {})), scenes: scenes };
}

function senseProblems(d, n) {
  const v = [];
  const sc = (d.scenes || []).map(cleanSense);
  if (sc.length !== n) v.push("장면 수가 " + n + "개여야 해요");
  if (sc.length >= 2) {
    const key = (s) => DIMS.map((k) => s[k]).join("|");
    if (sc.every((s) => key(s) === key(sc[0]))) v.push("모든 장면의 값이 똑같아요. 장면마다 느낌에 맞게 다르게 정해 주세요");
  }
  return v;
}

// ---------------------------------------------------------------------
// 요청 처리
// ---------------------------------------------------------------------
async function findFrame(image) {
  const r = await callAI([
    { role: "system", content:
      "사진 속에서 사람이 감상하려는 작품(그림·포스터·조각·책 표지 등 문화 콘텐츠)이 있는 테두리를 찾는다.\n" +
      "작품 바깥의 글자, 가격, 버튼, 화면 테두리, 책상, 벽은 빼고 작품 자체만 감싼다.\n" +
      "좌표는 사진 전체 기준 [왼쪽, 위, 오른쪽, 아래], 0~1000. 작품이 사진을 거의 다 채우면 [0,0,1000,1000].\n" +
      '출력 JSON만: {"frame":[숫자4개],"what":"작품 종류 한 낱말"}' },
    { role: "user", content: [{ type: "image_url", image_url: { url: image, detail: "high" } }] }
  ], 0);
  const f = r.data.frame;
  return (Array.isArray(f) && f.length === 4 && f.every((v) => typeof v === "number")) ? f : null;
}

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
    const cropped = !!body.cropped;
    // [수정 6-3] 앱이 픽셀에서 직접 잰 사실 (흑백인지, 대표 색) — AI가 색을 지어내지 않게 알려 줌
    const pixel = body.pixel && typeof body.pixel === "object" ? {
      gray: !!body.pixel.gray,
      colors: (Array.isArray(body.pixel.colors) ? body.pixel.colors : []).slice(0, 3).map((c) => String(c).slice(0, 12))
    } : null;
    const images = (Array.isArray(body.images) ? body.images : [])
      .filter((s) => typeof s === "string" && s.startsWith("data:image/") && s.length < 2000000)
      .slice(0, 8);
    if (type !== "sound" && images.length === 0) return res.status(400).json({ error: "no_image" });

    // ---------- 0) 작품 테두리만 찾기 (앱이 이걸로 사진을 잘라 다시 보냄) ----------
    if (body.task === "frame") {          // (예전 방식, 지금 앱은 쓰지 않음)
      const frame = await findFrame(images[0]);
      return res.status(200).json({ ok: true, version: SERVER_VERSION, frame: frame, ms: { total: Date.now() - t0 } });
    }

    // ---------- 1) Original to Text ----------
    const userParts = [{ type: "text", text: (type === "video" ? "장면 사진은 시간 순서예요. " : "") + audioText(body.audio) }];
    images.forEach((url) => userParts.push({
      type: "image_url",
      image_url: { url: url, detail: type === "photo" ? "high" : "low" }   // 영상 장면은 저해상도로 (빠르고 저렴)
    }));
    const msgs = [
      { role: "system", content: textPrompt(type, explain, target, cropped, pixel) },
      { role: "user", content: userParts }
    ];
    const tText = Date.now();
    const first = await callAI(msgs, 0.6);      // 해설은 창의성 '중간'
    let text = first.data;

    // 대상이 여러 개라 골라야 할 때 → 여기서 멈추고 사용자에게 물어봄
    if (type === "photo" && !target && text.needs_choice && Array.isArray(text.candidates) && text.candidates.length >= 2) {
      return res.status(200).json({
        ok: true, needs_choice: true, version: SERVER_VERSION, model: first.model,
        candidates: text.candidates.slice(0, 4).map((c) => ({ name: String(c.name || "").slice(0, 20), cells: cleanCells(c.cells) })),
        ms: { text: Date.now() - tText, sense: 0, total: Date.now() - t0 }
      });
    }

    // ---------- 2) 규칙 검사기 → 어기면 한 번 고쳐 쓰게 함 ----------
    let violations = checkRules(text, explain, type, pixel);
    let tries = 1;
    if (violations.length) {
      const fix = await callAI(msgs.concat([
        { role: "assistant", content: JSON.stringify(text) },
        { role: "user", content: "다음 규칙을 어겼어요. 같은 모양의 JSON으로 고쳐 주세요:\n- " + violations.join("\n- ") }
      ]), 0.4);
      const v2 = checkRules(fix.data, explain, type, pixel);
      tries = 2;
      if (v2.length <= violations.length) { text = fix.data; violations = v2; }
    }
    const textMs = Date.now() - tText;

    // ---------- 3) Text to Sense (C 개선형) ----------
    const tSense = Date.now();
    const scenes = (text.scenes || []).slice(0, RULES.maxScenes);
    const senseIn = (pixel && pixel.gray ? "(앱이 잰 사실: 흑백 사진)\n" : "") +
      "종류: " + text.kind + "\n요약: " + text.summary + "\n자세한 해설: " + text.interpretation + "\n" +
      scenes.map((s, i) => "장면 " + (i + 1) + " (" + s.name + "): " + s.text + " / 보이는 모습: " + (s.look || "-")).join("\n") + "\n" + audioText(body.audio);
    // 감각 단계에는 번호 칸이 없는 원래 사진을 보냄 (칸 선이 색 판단을 방해하지 않게)
    const raw = (typeof body.rawImage === "string" && body.rawImage.startsWith("data:image/") && body.rawImage.length < 2000000) ? [body.rawImage] : images;
    const senseUser = [{ type: "text", text: senseIn }].concat(
      raw.slice(0, 4).map((url) => ({ type: "image_url", image_url: { url: url, detail: "low" } })));   // 느낌 판단에는 저해상도면 충분 (빠르고 저렴)
    const senseMsgs = [{ role: "system", content: sensePrompt() }, { role: "user", content: senseUser }];
    // 3번을 동시에 매김 (창의성 0.5) → 평균. 한 번만 매길 때보다 우연한 치우침이 줄고, 3번의 차이로 '흔들림'을 잴 수 있음
    const SAMPLES = 3;
    const runs = await Promise.allSettled(Array.from({ length: SAMPLES }, () => callAI(senseMsgs, 0.5)));
    const okRuns = runs.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!okRuns.length) throw (runs[0].reason || { status: 500, message: "sense failed" });
    const sense = { data: averageSense(okRuns.map((r) => r.data), scenes.length) };
    const sProblems = senseProblems(sense.data, scenes.length);
    const senseTries = okRuns.length;
    const senseMs = Date.now() - tSense;

    const sScenes = scenes.map((_, i) => cleanSense((sense.data.scenes || [])[i]));
    // [수정 5-1] 대비 강조는 끔: AI가 '비슷하다'고 본 장면을 일부러 다르게 만들면 없는 차이를 지어내는 것이 됨
    //            (장면끼리 구분되는지는 베버의 '알아챌 수 있는 최소 차이' 기준으로 소리·빛 쪽에서 설계)
    const CONTRAST_ON = false;
    const contrast = CONTRAST_ON ? spreadScenes(sScenes) : {};
    return res.status(200).json({
      ok: true,
      version: SERVER_VERSION,
      model: first.model,
      kind: text.kind || "기타",
      is_artwork: !!text.is_artwork,
      title_guess: text.title_guess || "",
      grid: GRID,
      frame_cells: cleanCells(text.frame_cells),
      target: target,
      summary: text.summary || "",
      interpretation: text.interpretation || "",
      whole: cleanSense(sense.data.whole),
      senseMethod: "사진 직접 보기 + 눈금 예시 + " + senseTries + "번 평균",
      scenes: scenes.map((s, i) => ({ name: s.name, text: s.text, cells: cleanCells(s.cells), look: s.look || "", sense: sScenes[i] })),
      contrast: contrast,
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
