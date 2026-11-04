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
const SERVER_VERSION = "7-3";   // 앱 '개발용 정보'에 표시됨 → 새 코드가 올라갔는지 확인용

// 사용할 AI 모델 (앞에서부터 시도). Vercel 환경 변수 OPENAI_MODEL로 바꿀 수 있음
const MODELS = [process.env.OPENAI_MODEL, "gpt-4o-mini", "gpt-5-mini"].filter(Boolean);
// [수정 6-11] '어느 영역이 무엇인지' 짚는 일(재질·이름 붙이기)은 gpt-4o-mini가 자주 틀림(머리카락을 '팔'로, 의자를 '남성'으로)
//   → 이 일만 그림 위치를 더 잘 보는 큰 모델을 먼저 씀 (없으면 차례로 다음 모델). 1번에 약 10원 안팎 더 듦
const VISION_MODELS = [process.env.OPENAI_VISION_MODEL, "gpt-4.1", "gpt-4o", "gpt-4o-mini"].filter(Boolean);
// [수정 7-3] 소리를 '직접 듣는' 모델 (앞에서부터 시도). 계정에서 못 쓰는 모델이면 다음으로, 모두 안 되면 예전처럼 숫자로만 짐작
const AUDIO_MODELS = [process.env.OPENAI_AUDIO_MODEL, "gpt-audio-mini", "gpt-audio-1.5", "gpt-audio", "gpt-4o-mini-audio-preview", "gpt-4o-audio-preview"].filter(Boolean);

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

// [수정 6-4] 재질 목록 — 만져보기의 문지르는 소리와 전체 느끼기의 악기를 고르는 데 씀
// [수정 6-8] 분위기 낱말 30가지 — '더 다양하게(까리한, 관능적인, 차가운…)' 의견. 감각 수치를 매기는 같은 AI가 함께 고름 → 음악 장르와 어긋나지 않게
const MOOD_TAGS = ["평화로운", "고요한", "따뜻한", "포근한", "그리운", "쓸쓸한", "외로운", "슬픈", "우울한", "긴장된", "불안한", "무서운",
  "신비로운", "몽환적인", "웅장한", "엄숙한", "경쾌한", "신나는", "힘찬", "귀여운", "사랑스러운", "낭만적인", "관능적인",
  "세련된", "까리한", "차가운", "강렬한", "거친", "화난", "장난스러운"];
// [수정 6-9] 분위기 낱말의 위치 (러셀의 감정 원형 모형: 가로 = 기분, 세로 = 활기) — 우리 팀이 정한 대략의 자리
//   쓰임 ① 낱말과 수치가 어긋날 때 맞추기: '강렬한'이라고 해 놓고 활기 0.30이면 → 음악·진동이 잔잔해지는 문제
//        → AI가 매긴 기분·활기를 낱말 자리 쪽으로 절반만큼 옮김 (원래 값과 옮긴 값을 개발용 정보에 공개)
const TAG_VA = {
  "평화로운": [0.75, 0.2], "고요한": [0.6, 0.12], "따뜻한": [0.75, 0.35], "포근한": [0.75, 0.25], "그리운": [0.4, 0.3],
  "쓸쓸한": [0.3, 0.25], "외로운": [0.25, 0.25], "슬픈": [0.15, 0.3], "우울한": [0.15, 0.2], "긴장된": [0.3, 0.75],
  "불안한": [0.25, 0.7], "무서운": [0.15, 0.8], "신비로운": [0.55, 0.4], "몽환적인": [0.6, 0.3], "웅장한": [0.6, 0.75],
  "엄숙한": [0.4, 0.35], "경쾌한": [0.8, 0.7], "신나는": [0.9, 0.85], "힘찬": [0.7, 0.85], "귀여운": [0.85, 0.55],
  "사랑스러운": [0.85, 0.5], "낭만적인": [0.75, 0.45], "관능적인": [0.6, 0.55], "세련된": [0.6, 0.5], "까리한": [0.55, 0.65],
  "차가운": [0.35, 0.4], "강렬한": [0.45, 0.85], "거친": [0.35, 0.75], "화난": [0.15, 0.9], "장난스러운": [0.8, 0.7]
};
//   쓰임 ② AI가 낱말을 빠뜨렸을 때: 'AI가 느낀 분위기' 문장과 감정 낱말에서 찾아 채움 (예: '강한 느낌' → 강렬한)
const TAG_STEMS = [
  [/강렬|강한|강하게|압도/, "강렬한"], [/긴장/, "긴장된"], [/불안/, "불안한"], [/무섭|무서|공포|섬뜩|으스스/, "무서운"],
  [/평화/, "평화로운"], [/고요|조용|잔잔/, "고요한"], [/따뜻|따스/, "따뜻한"], [/포근|아늑/, "포근한"], [/그리운|그리움|향수/, "그리운"],
  [/쓸쓸/, "쓸쓸한"], [/외로/, "외로운"], [/슬프|슬픈|슬픔/, "슬픈"], [/우울|어두운 기분/, "우울한"], [/신비/, "신비로운"],
  [/몽환|꿈같|꿈 같/, "몽환적인"], [/웅장|장엄/, "웅장한"], [/엄숙|경건/, "엄숙한"], [/경쾌|발랄/, "경쾌한"], [/신나|신난|흥겨/, "신나는"],
  [/힘찬|힘차|활기찬/, "힘찬"], [/귀여/, "귀여운"], [/사랑스/, "사랑스러운"], [/낭만/, "낭만적인"], [/관능|매혹/, "관능적인"],
  [/세련|고급/, "세련된"], [/까리|당당|카리스마|멋스러/, "까리한"], [/차갑|차가운|냉정/, "차가운"], [/거친|거칠/, "거친"],
  [/화난|분노|화가/, "화난"], [/장난/, "장난스러운"]
];
// [수정 6-9] 물건 이름 ↔ 재질이 어긋날 때 바로잡는 규칙 (AI가 '식물'이라고 해 놓고 재질을 '털'로 고른 경우 등)
const GLASS_RE = /유리|와인잔|술잔|물잔|유리병|안경|거울|창문|어항|전구/;
function matFromThing(thing, mat) {
  const t = thing.replace(/\s/g, "");
  if (!t) return null;
  if (/식물|나뭇잎|잎사귀|^잎|풀|꽃(?!병)|덩굴|이끼|잔디|민들레|나뭇가지|화초/.test(t) && !/화분|꽃병|화병|무늬|자수|그림/.test(t)
      && ["털·머리카락", "천", "피부", "모름"].includes(mat)) return "잎·풀";
  if (/머리카락|머리털|머릿결|앞머리|뒷머리|수염|갈기|동물털|털$|^털/.test(t) && !/모자|털실|붓|목도리|담요/.test(t)
      && ["잎·풀", "천", "피부", "모름", "흙"].includes(mat)) return "털·머리카락";
  if (GLASS_RE.test(t) && ["모름", "플라스틱", "얼음", "물"].includes(mat)) return "유리";
  if (/^(얼굴|손|왼손|오른손|팔|다리|목|어깨|이마|볼|뺨|피부|맨발|발|가슴)$/.test(t) && ["천", "모름", "털·머리카락"].includes(mat)) return "피부";
  return null;
}
function tagsFromText(text) {
  const out = [];
  TAG_STEMS.forEach(([re, t]) => { const m = re.exec(text); if (m && !out.some((x) => x.t === t)) out.push({ t: t, at: m.index }); });
  return out.sort((a, b) => a.at - b.at).map((x) => x.t).slice(0, 3);
}
function alignToTags(o, tags, k) {
  const vs = tags.filter((t) => TAG_VA[t]);
  if (!vs.length) return null;
  const wts = [1.5, 1, 0.7];
  let sw = 0, v = 0, a = 0;
  vs.forEach((t, i) => { sw += wts[i]; v += wts[i] * TAG_VA[t][0]; a += wts[i] * TAG_VA[t][1]; });
  v /= sw; a /= sw;
  const from = { valence: o.valence, arousal: o.arousal };
  o.valence = +(o.valence + (v - o.valence) * k).toFixed(2);
  o.arousal = +(o.arousal + (a - o.arousal) * k).toFixed(2);
  return { from: from, to: { valence: o.valence, arousal: o.arousal }, word: { valence: +v.toFixed(2), arousal: +a.toFixed(2) } };
}

const MATERIALS = ["유리", "도자기", "금속", "나무", "돌", "대리석", "천", "가죽", "피부", "종이", "플라스틱", "고무", "흙", "모래", "잎·풀", "털·머리카락", "물", "얼음", "물감·붓질", "모름"];   // [수정 6-7] 도자기·가죽·모래·얼음·물감 추가

const TEMPOS = ["느림", "보통", "빠름"];
const PITCHES = ["낮음", "중간", "높음"];
const TEXTURES = ["부드러움", "물결", "톡톡", "거침", "묵직함"];
const MODES = ["밝음", "신남", "차분함", "슬픔", "신비", "긴장"];   // (이제 숫자에서 코드가 계산하는 이름표)

// ---------------------------------------------------------------------
// 간단한 사용량 제한: 같은 인터넷 주소에서 10분에 300번까지
// [수정 6-6] 부스에서는 여러 폰이 같은 와이파이(= 같은 인터넷 주소)를 써서 60번이면 금방 막힘 → 300번으로
// ---------------------------------------------------------------------
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 300;
}

// ---------------------------------------------------------------------
// 1) Original to Text 지시문
// ---------------------------------------------------------------------
function textPrompt(type, explain, target, cropped, pixel, heard) {
  const perScene = explain === "short" ? 1 : 2;
  const what = {
    photo: "사용자가 휴대폰 카메라로 찍은 사진 1장",
    video: "사용자가 휴대폰으로 담은 영상에서 시간 순서대로 뽑은 장면 사진 여러 장과 소리 정보",
    sound: heard
      ? "사용자가 들려준 소리(최대 30초). 'AI가 직접 들은 내용'과 앱이 잰 숫자(크기·높낮이·강세·빠르기)가 함께 주어진다. 들은 내용을 바탕으로 쓴다"
      : "소리를 기기에서 분석한 숫자 정보(크기·변화·높낮이·강세). 실제 소리는 듣지 못했으니 '소리 크기와 빠르기로 짐작하면'처럼 추측임을 밝힌다",
    text: "사용자가 입력하거나 붙여 넣은 글 (작품 설명, 공연 안내, 시, 기사 등). 사진은 없다"
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
    "[생각 순서 — CoT(생각의 사슬)] 답을 쓰기 전에 think 칸에 짧게 적는다 (사용자에게는 보이지 않고, 개발용 정보에만 보임)",
    "- think.see: " + (type === "text" ? "글에 나온 중요한 사실 3~5개 (짧은 낱말)" : type === "sound" ? "실제로 들리는 것 3~5개 (짧은 낱말)" : "사진에 실제로 보이는 것 3~5개 (짧은 낱말)"),
    "- think.main: 그중 가장 중요한 것 하나와 이유 (한 줄)",
    "- think.easy: 어려운 낱말이 있으면 무엇으로 쉽게 바꿀지 (예: '구도 → 놓인 자리')",
    "",
    "[무엇을 쓸까]",
    "- kind: 찍힌 대상의 종류. 카메라로 찍었다고 '사진'이라고 하지 않는다. (그림, 조각, 사진작품, 포스터, 공연·무대, 영상 화면, 건축, 공예, 책, 음악, 일상 물건, 기타)",
    "- is_artwork: 문화예술 작품이면 true, 일상 물건·풍경이면 false. false여도 그 장면의 분위기와 느낌을 해설한다.",
    "- summary: 무엇이 보이는지 1문장. (사실만)",
    "- interpretation: 눈에 띄는 모습을 1~2문장 더. 자세·표정·움직임·밝고 어두움·크기처럼 사진에서 확인할 수 있는 것만. (이름은 예전 그대로지만 '해석'이 아니라 '더 자세한 해설'이다)",
    "- mood_line: AI가 느낀 분위기 1문장 (12어절 이하). 이것만 느낌을 써도 된다. 화면에는 'AI의 느낌(정답 아님)'으로 따로 표시된다.",
    "- material: 가장 중심이 되는 대상의 재질 하나. 다음 중에서 고른다: " + MATERIALS.join(", "),
    "- scenes: 눈에 띄는 부분 " + RULES.minScenes + "~" + RULES.maxScenes + "개. 각 부분에 '무엇이 어떻게 보이는지'만 쓴다.",
    "- 각 장면의 look: 감각으로 바꿀 재료. 실제로 보이는 색 이름·밝기·크기·움직임·표면을 20자 안팎으로 (사용자에게 보이지 않음. 이 칸은 쉬운 말 규칙 검사를 하지 않음).",
    type === "photo"
      ? "- 사진 위에 1~" + (GRID * GRID) + "번 번호가 적힌 " + GRID + "×" + GRID + " 칸이 그려져 있다. (왼쪽 위가 1번, 한 줄에 " + GRID + "칸씩, 오른쪽 아래가 " + (GRID * GRID) + "번)\n" +
        "  칸과 번호는 위치를 알려 주는 표시일 뿐이니 해설에는 쓰지 않는다.\n" +
        "- frame_cells: 작품(느낄 대상)이 들어 있는 칸 번호를 모두 쓴다. 화면 속 글자·가격·버튼·책상·벽만 있는 칸은 뺀다.\n" +
        "- 각 장면의 cells: 그 장면이 실제로 보이는 칸 번호를 모두 쓴다. 한 칸에 조금이라도 걸치면 넣는다. 장면마다 칸이 달라야 한다."
      : "- cells와 frame_cells는 빈 목록 [] 으로 둔다.",
    type === "video" ? "- 영상은 '무엇이 일어나는지'를 말한다. '보여요', '보여줘요'를 반복하지 않는다.\n" +
      "- 영상이면 scenes는 '시간 순서대로 나눈 장면'이다(앞 장면이 먼저). 각 장면에 frames: 그 장면에 해당하는 장면 사진 번호들(1부터, 겹치지 않게, 장면 순서대로 이어지게)을 쓴다. 모든 장면 사진이 어느 한 장면에 들어가야 한다." : "",
    type === "text" ? "- 글이면: summary는 '무엇에 대한 글인지', interpretation과 scenes는 글의 중요한 내용을 쉬운 말로. 글에 없는 내용은 지어내지 않는다. 장면 대신 '중요한 부분'으로 나눈다. material은 글에 나온 중심 대상의 재질(모르면 '모름')." : "",
    type === "sound" ? "- 소리면: kind는 음악·노래·말소리·자연 소리·생활 소리·섞인 소리 중 하나. summary는 '무슨 소리인지' 1문장. interpretation은 소리의 크기·빠르기·높낮이가 어떻게 들리는지.\n" +
      "  scenes는 '시간 순서대로 나눈 소리의 부분' 2~4개. 각 부분에 from, to (초, 숫자)를 쓴다. 겹치지 않게, 처음은 0초, 끝은 전체 길이.\n" +
      "  사람 말이 들리면 그 내용을 쉬운 말로 짧게 옮긴다 (말한 사람이 누구인지는 추측하지 않는다). 노래 가사는 그대로 옮겨 적지 않고 '무엇에 대한 노래인지'만.\n" +
      "  '들려요'를 문장마다 반복하지 않는다. 소리에 없는 모습·색은 지어내지 않는다. material은 '모름'." : "",
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
    type === "sound" ? "8. 냄새, 모습, 색처럼 소리로 알 수 없는 것은 쓰지 않는다." : "8. 소리, 냄새, 바람, 온도처럼 사진에 찍히지 않는 것은 쓰지 않는다.",
    "",
    "[정직 규칙]",
    "- short_name: 갤러리 액자 아래에 붙일 짧은 이름 (12자 이내, 보이는 것으로. 예: '검은 옷의 남성', '빨간 붓글씨'). 제목을 안다면 제목.",
    "- 작품 이름은 확실할 때만 title_guess에, 아니면 빈 문자열. '작품 안내판 정보'가 주어지면 그 제목을 title_guess에 쓰고, 해설에 작가·연도를 써도 된다.",
    "- 보이지 않는 것은 지어내지 않는다. 잘 안 보이면 '잘 보이지 않아요'라고 쓴다.",
    pixel && pixel.gray ? "- 앱이 사진의 픽셀을 직접 재 보니 이 사진은 흑백이다. 빨강·파랑·노랑 같은 색 이름이나 '화려한 색'을 쓰지 않는다. 흰색·검은색·회색, 밝고 어두움만 쓴다." : "",
    pixel && !pixel.gray && pixel.colors && pixel.colors.length ? "- 앱이 픽셀에서 잰 대표 색: " + pixel.colors.join(", ") + ". 색을 말할 때는 실제로 보이는 색만 쓴다." : "",
    "- 사람이 보이면 누구인지 추측하지 않고, 얼굴 생김새를 자세히 묘사하지 않는다.",
    "",
    "[좋은 예 — 밤하늘 그림]",
    '{"think":{"see":["밤하늘","소용돌이","노란 별","작은 마을"],"main":"하늘의 소용돌이 — 그림의 대부분을 차지함","easy":"붓질 → 굵은 선"},"kind":"그림","is_artwork":true,"title_guess":"","short_name":"소용돌이치는 밤하늘","needs_choice":false,"material":"천","mood_line":"조용한 밤에 마음이 들뜨는 느낌이에요.","candidates":[],"frame_cells":[작품이 있는 칸 번호들],',
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
    "- (whole에만) mood_tags: 아래 목록에서 이 작품의 분위기에 가장 맞는 낱말 1~3개. 가장 강한 것을 맨 앞에.",
    "  목록: " + MOOD_TAGS.join(", "),
    "  ('까리한' = 멋스럽고 당당한, '세련된' = 깔끔하고 도시적인, '관능적인' = 부드러운 곡선과 은은한 매혹. 아이·학생 사진에는 '관능적인'을 쓰지 않는다)",
    "  입력에 'AI가 느낀 분위기' 문장이 있으면 그 문장과 어긋나지 않게 고른다.",
    "",
    "[규칙]",
    "- 눈금 예시와 비교해서 가장 가까운 위치를 고른다. 근거 없이 0.5를 고르지 않는다.",
    "- valence(기분)는 '작품이 잘 만들어졌는지'가 아니라 '보이는 장면의 기분'이다. 기쁨이 분명히 보일 때만 0.8 이상.",
    "  싸움, 고통, 죽음, 슬픔이 보이면 이겼거나 영웅적이어도 0.4 아래. 엄숙하거나 무표정이면 0.5 근처.",
    "- arousal(활기)은 '감정의 에너지'다. 움직임이 보이거나, 멈춰 있어도 눈빛·표정·강한 명암 대비·긴장감이 강렬하면 높게.",
    "  잔잔한 정물·풍경, 편안한 표정은 낮게. 분위기 낱말(mood_tags)과 숫자가 어긋나지 않게 한다(예: '강렬한'인데 활기 0.3은 안 됨).",
    "- 장면마다 사진에서 그 부분만 보고 매긴다. 장면 순서와 개수는 입력과 똑같이.",
    "- whole은 사진 전체를 처음 봤을 때의 종합적인 느낌이다.",
    "",
    "[출력] JSON만. 아래 모양 그대로, 모든 칸을 빠짐없이 채운다 (scenes는 입력 장면 수만큼):",
    '{"whole":{"mood_tags":["강렬한"],"emotion":"강렬함","valence":0.45,"arousal":0.8,"brightness":0.3,"weight":0.6,"roughness":0.5,"flow":0.4,"colors":["#AA0000"],"why":"…"},' +
    ' "scenes":[{"emotion":"…","valence":0.5,"arousal":0.5,"brightness":0.5,"weight":0.5,"roughness":0.5,"flow":0.5,"colors":["#000000"],"why":"…"}]}',
    "(숫자는 예시일 뿐 — 사진을 보고 새로 매긴다. 장면의 emotion도 그 장면의 느낌으로 꼭 쓴다)"
  ].join("\n");
}

function audioText(a) {
  if (!a) return "소리 정보: 없음";
  return "소리 정보(기기 분석): 크기 " + a.loud + ", " + a.change + ", " + a.pitch +
    ", 강세 " + a.accents + "번" + (a.bpm ? ", 빠르기 약 " + a.bpm + " BPM" : "") +
    ", 길이 " + Number(a.sec).toFixed(0) + "초";
}

// ---------------------------------------------------------------------
// [수정 7-3] 소리 직접 듣기 — 앱이 보낸 16kHz 녹음(WAV, 최대 30초)을 오디오 모델에게 들려줌
//   돌려받는 것: 무슨 소리인지, 들리는 것들, 사람 말이면 그 내용 요약, 시간 순서 부분(초)
//   어떤 모델도 못 쓰면 null → 예전처럼 숫자로만 짐작 (앱 화면에 '직접 듣지 못했어요'라고 밝힘)
// ---------------------------------------------------------------------
function parseLooseJSON(t) {
  const s = String(t || "").replace(/```(json)?/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
async function listenAI(b64, sec) {
  const sys = [
    "너는 소리를 듣고 무엇이 들리는지 정확하게 적는 도우미다. 지어내지 않는다. 잘 안 들리면 '잘 들리지 않음'이라고 쓴다.",
    "전체 길이는 약 " + Math.round(sec) + "초다.",
    "JSON만 출력한다:",
    '{"kind":"음악|노래|말소리|자연 소리|생활 소리|섞인 소리","heard":["들리는 것 3~5개, 짧게 (예: 피아노, 빗소리, 여자 목소리)"],',
    ' "speech":"사람 말이 또렷하면 무슨 내용인지 1~2문장으로 요약 (가사는 그대로 적지 않고 무엇에 대한 노래인지만). 없으면 빈 문자열",',
    ' "tempo":"느림|보통|빠름","loud":"작음|보통|큼|점점 커짐|점점 작아짐|크고 작음이 바뀜",',
    ' "parts":[{"from":0,"to":10,"what":"그동안 들리는 것 (15자 안팎)"}]}  (parts는 2~4개, 시간 순서, 겹치지 않게)'
  ].join("\n");
  let lastErr = null;
  for (const model of AUDIO_MODELS) {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: model, modalities: ["text"], max_completion_tokens: 700,   // (창의성 값은 보내지 않음: 모델마다 받는 값이 달라 거절될 수 있음)
        messages: [{ role: "system", content: sys },
                   { role: "user", content: [{ type: "text", text: "이 소리에서 무엇이 들리나요?" }, { type: "input_audio", input_audio: { data: b64, format: "wav" } }] }] })
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) }));
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      const d = parseLooseJSON(typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text || "").join("") : "");
      if (d) return { data: d, model: model };
      lastErr = { status: 500, message: "듣기 결과가 JSON이 아님 (" + model + ")" };
      continue;
    }
    lastErr = { status: r.status, message: (j.error && j.error.message) || "" , model: model };
    if (r.status === 401) break;                                  // 키 문제면 더 해 봐야 소용없음
  }
  return { data: null, error: lastErr };
}
function heardText(h, sec) {
  if (!h) return "";
  const parts = (Array.isArray(h.parts) ? h.parts : []).slice(0, 4).map((p) => Number(p.from).toFixed(0) + "~" + Number(p.to).toFixed(0) + "초: " + String(p.what || "").slice(0, 40)).join(" / ");
  return "[AI가 직접 들은 내용 — 사실로 써도 됨]\n종류: " + String(h.kind || "").slice(0, 12) +
    "\n들리는 것: " + (Array.isArray(h.heard) ? h.heard.slice(0, 6).map((x) => String(x).slice(0, 20)).join(", ") : "") +
    (h.speech ? "\n말 내용(요약): " + String(h.speech).slice(0, 200) : "") +
    "\n빠르기: " + String(h.tempo || "-").slice(0, 8) + " · 크기: " + String(h.loud || "-").slice(0, 16) +
    (parts ? "\n시간 순서: " + parts : "") + "\n전체 길이: 약 " + Math.round(sec) + "초\n";
}

// ---------------------------------------------------------------------
// OpenAI 부르기 (모델을 앞에서부터 시도)
// ---------------------------------------------------------------------
async function callAI(messages, temperature, models) {
  let lastErr = null;
  for (const model of (models || MODELS)) {
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
  const all = [d.summary, d.interpretation].concat(scenes.map((s) => s.text)).join(" ");   // mood_line은 느낌 칸이라 해석 낱말 검사에서 뺌
  const ml = sentencesOf(d.mood_line);
  if (ml.length > 1) v.push("mood_line이 " + ml.length + "문장이에요 (1문장)");
  ml.forEach((x) => { if (wordsOf(x) > RULES.maxWords) v.push("mood_line이 " + wordsOf(x) + "어절이에요 (" + RULES.maxWords + "어절 이하)"); });
  JUDGE_WORDS.forEach((w) => { if (String(d.mood_line || "").includes(w)) v.push("mood_line에 평가하는 말 '" + w + "…'을 썼어요"); });
  HARD_WORDS.forEach((w) => { if (all.includes(w)) v.push("어려운 낱말 '" + w + "'을 썼어요"); });
  JUDGE_WORDS.forEach((w) => { if (all.includes(w)) v.push("평가하는 말 '" + w + "…'을 썼어요. 보이는 모습으로 바꿔 주세요"); });
  if (type !== "text") FEEL_WORDS.forEach((w) => { if (all.includes(w)) v.push("해석하는 말 '" + w + "'을 썼어요. 느낌은 빼고 보이는 것만 써 주세요"); });
  if (pixel && pixel.gray) COLOR_WORDS.forEach((w) => { if (all.includes(w)) v.push("흑백 사진인데 색 낱말 '" + w + "'을 썼어요. 흰색·검은색·회색, 밝고 어두움으로만 써 주세요"); });
  if (type === "video" && (all.match(/보여/g) || []).length > 2) v.push("'보여요/보여줘요'를 너무 많이 썼어요. 무엇이 일어나는지를 말해 주세요");
  if (type === "sound" && (all.match(/들려/g) || []).length > 3) v.push("'들려요'를 너무 많이 썼어요. 무슨 소리가 어떻게 나는지를 말해 주세요");
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
    emotion: String(s.emotion || "").slice(0, 12),
    colors: (Array.isArray(s.colors) ? s.colors : []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3),
    why: String(s.why || "").slice(0, 40)
  };
  DIMS.forEach((k) => { o[k] = n01(s[k], 0.5); });
  if (s.spread) o.spread = s.spread;
  if (Array.isArray(s.mood_tags)) o.mood_tags = s.mood_tags.filter((t) => MOOD_TAGS.includes(t)).slice(0, 3);
  labelsOf(o);
  // [수정 6-10] AI가 감정 낱말을 빠뜨리면 예전에는 '평온'으로 채워서, 강렬한 작품의 장면이 '평온'으로 보였음 → 숫자로 계산한 분위기 이름으로
  if (!o.emotion) o.emotion = { "긴장": "긴장감", "슬픔": "쓸쓸함", "신비": "신비로움", "신남": "신남", "밝음": "밝음", "차분함": "차분함" }[o.mode] || "차분함";
  return o;
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
    const out = Object.assign({}, objs.find((o) => o && o.emotion) || objs[0] || {});
    const spread = {};
    DIMS.forEach((k) => {
      // [수정 6-10] 빠뜨린 값(0.5로 채워진 것)은 평균에서 빼고, 실제로 매긴 값만 평균
      const real = objs.map((o, i) => (isFinite(Number(o && o[k])) && o[k] !== null && o[k] !== "" ? cl[i][k] : null)).filter((x) => x !== null);
      const v = real.length ? real : cl.map((o) => o[k]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      out[k] = +m.toFixed(2);
      spread[k] = +(v.reduce((a, b) => a + Math.abs(b - m), 0) / v.length).toFixed(3);   // 평균에서 벗어난 정도
    });
    out.spread = spread;
    return out;
  };
  const scenes = [];
  for (let i = 0; i < n; i++) scenes.push(avgOne(list.map((d) => (d.scenes || [])[i] || {})));
  const whole = avgOne(list.map((d) => d.whole || {}));
  // 분위기 낱말: 3번 중 많이 나온 순서 (같으면 앞에 놓인 것 우선) → 최대 3개
  const votes = new Map();
  list.forEach((d) => ((d.whole && d.whole.mood_tags) || []).forEach((t, i) => {
    if (MOOD_TAGS.includes(t)) votes.set(t, (votes.get(t) || 0) + 1 + (2 - Math.min(2, i)) * 0.1);
  }));
  whole.mood_tags = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  return { whole: whole, scenes: scenes };
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
    const type = ["photo", "video", "sound", "text"].includes(body.type) ? body.type : "photo";
    const inText = type === "text" ? String(body.text || "").trim().slice(0, 2000) : "";
    if (type === "text" && inText.length < 2) return res.status(400).json({ error: "no_text" });
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
    if (type !== "sound" && type !== "text" && images.length === 0) return res.status(400).json({ error: "no_image" });

    // ---------- 0) 작품 테두리만 찾기 (앱이 이걸로 사진을 잘라 다시 보냄) ----------
    // ---------- [수정 6-4] 만져보기: 앱이 나눈 덩어리(번호가 그려진 사진)마다 재질 이름 붙이기 ----------
    if (body.task === "materials") {
      // [수정 6-9] 최대 24영역 (앱이 더 잘게 나눈 뒤, AI가 '같은 물건'이라고 한 이웃끼리 합침)
      //   + imp(감상에서 중요한 정도) → 눈길 안내가 '의자 천'처럼 덜 중요한 곳을 고르지 않게
      //   + heavy(가벼운/묵직한) → 같은 금속이라도 얇은 장신구와 묵직한 조각상의 소리를 다르게
      const n = Math.max(1, Math.min(24, Number(body.n) || 1));
      const sys = [
        "너는 사진 속 물체와 재질을 알아보는 도우미다.",
        "사진 두 장을 준다. 1번 사진 = 전체 그림 위에 앱이 색·밝기로 나눈 영역의 테두리와 1~" + n + "번 번호.",
        "2번 사진 = 영역마다 따로 잘라 모은 칸들. 각 칸 왼쪽 위 숫자가 영역 번호이고, 그 칸에서 '밝게 남아 있고 노란 선으로 둘러싸인 부분'만 그 영역이다(어둡게 가려진 곳은 다른 영역).",
        "각 영역이 무엇인지는 반드시 2번 사진의 그 번호 칸을 보고 정한다. 1번 사진은 그것이 전체에서 어디인지 확인하는 데만 쓴다. 번호·테두리·노란 선은 표시일 뿐 재질이 아니다.",
        "먼저 seen에 사진 전체에 보이는 주요 물체를 한 줄로 적는다. 그다음 각 번호 영역마다:",
        "- thing: 그 영역이 무엇인지 5자 안팎 (같은 물건이면 여러 영역에 똑같은 이름을 쓴다. 예: '의자 등받이' 둘이면 둘 다 '의자 등받이')",
        "  배경과 그 위에 놓인 모양·글자·로고는 서로 다른 이름을 쓴다 (예: '빨간 배경', '검은 붓 글씨', '제목 글자'). 추상화라도 색이 다른 형태는 나눠 부른다.",
        "- material: 손으로 만지면 어떤 재질일지. 다음 중 하나만: " + MATERIALS.join(", ") + ".",
        "- heavy: 그 물체가 묵직하면 true(큰 조각상, 두꺼운 돌, 철 덩어리, 큰 가구), 얇고 가벼우면 false(장신구, 얇은 판, 단추, 작은 소품)",
        "- imp: 이 작품을 감상할 때 눈여겨볼 정도. 3 = 주인공의 얼굴 또는 작품의 중심 물체(1~2곳만), 2 = 손, 손에 든 물건, 상징적인 소품·장식, 1 = 보조, 0 = 배경·바닥·벽·빈 곳",
        "  옷(상의·하의·바지·치마), 몸 전체, 의자·가구, 커튼처럼 넓기만 한 곳은 1 이하로 한다.",
        "- sure: 재질이 확실하면 true, 헷갈리면 false (그래도 가장 그럴듯한 재질을 고른다)",
        "[재질 규칙]",
        "- 그림·포스터·사진 속 물체도 '그 물체'의 재질을 고른다 (인쇄물이라서 종이로 고르지 않는다).",
        "- '천'은 옷, 커튼, 쿠션, 의자 등받이의 천처럼 부드러운 것만. 조각이 새겨진 의자 틀·팔걸이·액자·가구 장식은 단단하니 '나무' 또는 '금속'(은빛·반짝이면 금속).",
        "- '유리': 투명하거나 반투명해서 뒤가 비쳐 보이는 것, 또는 유리잔·병·창문·유리 꽃병·안경알·거울. 반짝이기만 하는 불투명한 그릇·화분은 '도자기'.",
        "- 매끈하게 다듬은 조각상·기둥은 '대리석', 울퉁불퉁한 바위·벽돌·시멘트는 '돌'.",
        "- '털·머리카락'은 사람의 머리털·수염, 동물의 털·갈기에만. 식물·꽃·풀·나뭇잎은 털처럼 보여도 '잎·풀'.",
        "- 하늘·흐린 배경·빛처럼 만질 수 없는 곳은 '모름'.",
        "- 그림 속 물체를 알아보기 어렵고 붓 자국만 보이면 '물감·붓질'.",
        '[출력] JSON만: {"seen":"…","regions":[{"n":1,"thing":"얼굴","material":"피부","heavy":false,"imp":3,"sure":true}, ...]} (1~' + n + '번 모두)'
      ].join("\n");
      const first = await callAI([{ role: "system", content: sys },
        { role: "user", content: [{ type: "text", text: "영역 수: " + n }].concat(images.slice(0, 2).map((u) => ({ type: "image_url", image_url: { url: u, detail: "high" } }))) }], 0.2, VISION_MODELS);
      let fixed = 0;
      const regs = (Array.isArray(first.data.regions) ? first.data.regions : []).map((r) => {
        const thing = String(r.thing || "").slice(0, 12);
        let material = MATERIALS.includes(r.material) ? r.material : "모름";
        const sure = r.sure !== false;
        // 이름과 재질이 서로 어긋나면 이름을 따름 (예: thing '식물'인데 재질 '털·머리카락' → 잎·풀)
        const want = matFromThing(thing, material);
        if (want && want !== material) { material = want; fixed++; }
        if (!sure && material === "유리" && !GLASS_RE.test(thing)) material = "모름";   // 유리는 확실할 때만 (아닌 것을 유리로 듣는 게 더 어색함)
        return { n: Math.round(Number(r.n)), material: material, thing: thing, sure: sure,
                 heavy: r.heavy === true, imp: Math.max(0, Math.min(3, Math.round(Number(r.imp) || 0))) };
      }).filter((r) => r.n >= 1 && r.n <= n);
      return res.status(200).json({ ok: true, version: SERVER_VERSION, model: first.model, seen: String(first.data.seen || "").slice(0, 120),
                                    regions: regs, fixed: fixed, ms: { total: Date.now() - t0 } });
    }

    if (body.task === "frame") {          // (예전 방식, 지금 앱은 쓰지 않음)
      const frame = await findFrame(images[0]);
      return res.status(200).json({ ok: true, version: SERVER_VERSION, frame: frame, ms: { total: Date.now() - t0 } });
    }

    // ---------- 1) Original to Text ----------
    // [수정 6-5] 미니 벽화 QR 작품이면 안내판의 작품 정보(제목·작가·연도)를 함께 줌 → 제목을 추측하지 않아도 됨
    const w = body.work && typeof body.work === "object" ? body.work : null;
    const workInfo = w && w.title ? "[작품 안내판 정보 — 사실로 써도 됨] 제목: " + String(w.title).slice(0, 60) +
      (w.artist ? " / 작가: " + String(w.artist).slice(0, 40) : "") + (w.year ? " / 연도: " + String(w.year).slice(0, 20) : "") +
      (w.note ? " / 설명: " + String(w.note).slice(0, 200) : "") + "\n" : "";
    // [수정 7-3] 소리: 먼저 직접 듣기
    let heard = null, listenInfo = null;
    const soundSec = body.audio && isFinite(Number(body.audio.sec)) ? Number(body.audio.sec) : 30;
    if (type === "sound" && typeof body.audioWav === "string" && body.audioWav.length > 1000 && body.audioWav.length < 3500000) {
      const tL = Date.now();
      const L = await listenAI(body.audioWav.replace(/^data:audio\/\w+;base64,/, ""), soundSec);
      heard = L.data; listenInfo = { model: L.model || null, ms: Date.now() - tL, error: L.error ? String(L.error.message || L.error.status).slice(0, 160) : null };
    }
    const userParts = [{ type: "text", text: workInfo + (type === "text" ? "[사용자가 넣은 글]\n" + inText : (type === "video" ? "장면 사진은 시간 순서예요. " : "") + heardText(heard, soundSec) + audioText(body.audio)) }];
    const times = Array.isArray(body.times) ? body.times.map(Number) : [];
    images.forEach((url, i) => {
      if (type === "video") userParts.push({ type: "text", text: "[장면 사진 " + (i + 1) + (isFinite(times[i]) ? " · 약 " + times[i].toFixed(1) + "초" : "") + "]" });   // [수정 6-12] 번호·시각을 사진 바로 앞에
      userParts.push({ type: "image_url", image_url: { url: url, detail: type === "photo" ? "high" : "low" } });   // 영상 장면은 저해상도로 (빠르고 저렴)
    });
    const msgs = [
      { role: "system", content: textPrompt(type, explain, target, cropped, pixel, !!heard) },
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
      (type === "text" ? "(사진 없음 — 아래 글과 원래 글만 보고 매긴다. 밝기·무게·거칠기·흐름은 글이 그리는 장면을 떠올려서)\n원래 글: " + inText.slice(0, 800) + "\n" : "") +
      "종류: " + text.kind + "\n요약: " + text.summary + "\n자세한 해설: " + text.interpretation + "\n" +
      (text.mood_line ? "AI가 느낀 분위기: " + text.mood_line + "\n" : "") +
      scenes.map((s, i) => "장면 " + (i + 1) + " (" + s.name + "): " + s.text + " / 보이는 모습: " + (s.look || "-")).join("\n") + "\n" + heardText(heard, soundSec) + audioText(body.audio);
    // 감각 단계에는 번호 칸이 없는 원래 사진을 보냄 (칸 선이 색 판단을 방해하지 않게)
    const raw = type === "text" ? [] : (typeof body.rawImage === "string" && body.rawImage.startsWith("data:image/") && body.rawImage.length < 2000000) ? [body.rawImage] : images;
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

    // [수정 6-9] 분위기 낱말이 비었으면 문장에서 찾아 채우고, 기분·활기를 낱말 자리 쪽으로 절반 옮김 (낱말 ↔ 숫자 일치)
    const W0 = sense.data.whole;
    let tagFrom = "AI가 고름";
    if (!Array.isArray(W0.mood_tags) || !W0.mood_tags.length) {
      W0.mood_tags = tagsFromText([text.mood_line || "", W0.emotion || ""].join(" "));
      tagFrom = W0.mood_tags.length ? "분위기 문장에서 찾음" : "없음";
    }
    const tagAlign = alignToTags(W0, W0.mood_tags, 0.5);
    const wholeOut = Object.assign(cleanSense(W0), { tag_from: tagFrom, tag_align: tagAlign });
    const sScenes = scenes.map((_, i) => Object.assign(cleanSense((sense.data.scenes || [])[i]), { mood_tags: wholeOut.mood_tags || [] }));
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
      short_name: String(text.short_name || "").slice(0, 16),
      grid: GRID,
      frame_cells: cleanCells(text.frame_cells),
      target: target,
      summary: text.summary || "",
      interpretation: text.interpretation || "",
      mood_line: String(text.mood_line || "").slice(0, 80),
      think: text.think && typeof text.think === "object" ? {
        see: (Array.isArray(text.think.see) ? text.think.see : []).slice(0, 6).map((x) => String(x).slice(0, 20)),
        main: String(text.think.main || "").slice(0, 80), easy: String(text.think.easy || "").slice(0, 80)
      } : null,
      material: MATERIALS.includes(text.material) ? text.material : "모름",
      whole: wholeOut,
      senseMethod: "사진 직접 보기 + 눈금 예시 + " + senseTries + "번 평균",
      scenes: scenes.map((s, i) => ({ name: s.name, text: s.text, cells: cleanCells(s.cells), look: s.look || "", sense: sScenes[i],
        frames: type === "video" && Array.isArray(s.frames) ? s.frames.map((f) => Math.round(Number(f))).filter((f) => f >= 1 && f <= images.length).slice(0, 12) : undefined,
        from: type === "sound" && isFinite(Number(s.from)) ? Math.max(0, Number(s.from)) : undefined,
        to: type === "sound" && isFinite(Number(s.to)) ? Math.max(0, Number(s.to)) : undefined })),
      heard: heard ? { kind: String(heard.kind || "").slice(0, 12), heard: (Array.isArray(heard.heard) ? heard.heard : []).slice(0, 6).map((x) => String(x).slice(0, 20)),
                       speech: String(heard.speech || "").slice(0, 200), tempo: String(heard.tempo || "").slice(0, 8), loud: String(heard.loud || "").slice(0, 16) } : null,
      listen: listenInfo,
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
