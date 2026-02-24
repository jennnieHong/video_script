// ============================================================
// engToKor.ts — 영어 → 한글 발음 변환 (음절 조합 방식)
// ============================================================

const BASE = 0xAC00;

// 초성(19), 중성(21), 종성(28) 인덱스
const CHO: Record<string, number> = {
  'ㄱ':0,'ㄲ':1,'ㄴ':2,'ㄷ':3,'ㄸ':4,'ㄹ':5,'ㅁ':6,'ㅂ':7,'ㅃ':8,
  'ㅅ':9,'ㅆ':10,'ㅇ':11,'ㅈ':12,'ㅉ':13,'ㅊ':14,'ㅋ':15,'ㅌ':16,'ㅍ':17,'ㅎ':18
};
const JUNG: Record<string, number> = {
  'ㅏ':0,'ㅐ':1,'ㅑ':2,'ㅒ':3,'ㅓ':4,'ㅔ':5,'ㅕ':6,'ㅖ':7,
  'ㅗ':8,'ㅘ':9,'ㅙ':10,'ㅚ':11,'ㅛ':12,'ㅜ':13,'ㅝ':14,'ㅞ':15,
  'ㅟ':16,'ㅠ':17,'ㅡ':18,'ㅢ':19,'ㅣ':20
};
const JONG: Record<string, number> = {
  '':0,'ㄱ':1,'ㄲ':2,'ㄳ':3,'ㄴ':4,'ㄵ':5,'ㄶ':6,'ㄷ':7,
  'ㄹ':8,'ㄺ':9,'ㄻ':10,'ㄼ':11,'ㄽ':12,'ㄾ':13,'ㄿ':14,'ㅀ':15,
  'ㅁ':16,'ㅂ':17,'ㅄ':18,'ㅅ':19,'ㅆ':20,'ㅇ':21,'ㅈ':22,'ㅊ':23,
  'ㅋ':24,'ㅌ':25,'ㅍ':26,'ㅎ':27
};

function compose(cho: string, jung: string, jong = ''): string {
  const c = CHO[cho], j = JUNG[jung], jo = JONG[jong];
  if (c === undefined || j === undefined || jo === undefined) return '';
  return String.fromCharCode(BASE + c * 21 * 28 + j * 28 + jo);
}

// ── 영어 → 초성 매핑 (긴 것 우선) ──
const ONSETS: [string, string][] = [
  ['ch','ㅊ'],['sh','ㅅ'],['th','ㄸ'],['ph','ㅍ'],['wh','ㅎ'],
  ['wr','ㄹ'],['kn','ㄴ'],['gn','ㄴ'],['qu','ㅋ'],
  ['b','ㅂ'],['c','ㅋ'],['d','ㄷ'],['f','ㅍ'],['g','ㄱ'],['h','ㅎ'],
  ['j','ㅈ'],['k','ㅋ'],['l','ㄹ'],['m','ㅁ'],['n','ㄴ'],['p','ㅍ'],
  ['r','ㄹ'],['s','ㅅ'],['t','ㅌ'],['v','ㅂ'],['x','ㅋ'],
  ['z','ㅈ'],
  // w, y는 모음 패턴으로 처리 (onset에서 제외)
];

// ── 영어 모음 패턴 → 중성 (여러 음절 가능) ──
// 배열: 각 원소가 하나의 중성 (2개면 2음절)
const VOWELS: [string, string[]][] = [
  ['ough',['ㅗ']],['ight',['ㅏ','ㅣ']],
  ['you',['ㅠ']],['our',['ㅏ','ㅝ']],['ous',['ㅓ','ㅅ']],
  ['ai',['ㅔ','ㅣ']],['ay',['ㅔ','ㅣ']],['ei',['ㅔ','ㅣ']],['ey',['ㅔ','ㅣ']],
  ['ea',['ㅣ']],['ee',['ㅣ']],['ie',['ㅏ','ㅣ']],
  ['oa',['ㅗ']],['oo',['ㅜ']],['ou',['ㅏ','ㅜ']],
  ['oi',['ㅗ','ㅣ']],['oy',['ㅗ','ㅣ']],
  ['au',['ㅗ']],['aw',['ㅗ']],['ew',['ㅠ']],['ow',['ㅗ']],
  ['wa',['ㅘ']],['we',['ㅟ']],['wi',['ㅟ']],['wo',['ㅝ']],['wu',['ㅜ']],
  ['ya',['ㅑ']],['ye',['ㅖ']],['yi',['ㅣ']],['yo',['ㅛ']],['yu',['ㅠ']],
  ['a',['ㅏ']],['e',['ㅔ']],['i',['ㅣ']],['o',['ㅗ']],['u',['ㅓ']],
];

// ── 종성(받침) 매핑 ──
const CODAS: Record<string, string> = {
  b:'ㅂ', c:'ㄱ', d:'ㄷ', f:'ㅍ', g:'ㄱ', k:'ㅋ',
  l:'ㄹ', m:'ㅁ', n:'ㄴ', p:'ㅂ', r:'ㄹ', s:'ㅅ',
  t:'ㅌ', x:'ㄱ', z:'ㅈ',
};

// 'c' before e,i → ㅅ (soft c)
function getOnset(word: string, pos: number): [string, string] {
  for (const [pat, kor] of ONSETS) {
    if (word.startsWith(pat, pos)) {
      let k = kor;
      if (pat === 'c' && pos + 1 < word.length && 'eiy'.includes(word[pos + 1])) k = 'ㅅ';
      if (pat === 'g' && pos + 1 < word.length && 'eiy'.includes(word[pos + 1])) k = 'ㅈ';
      return [pat, k];
    }
  }
  return ['', 'ㅇ'];
}

function getVowel(word: string, pos: number): [string, string[]] {
  for (const [pat, kors] of VOWELS) {
    if (word.startsWith(pat, pos)) return [pat, kors];
  }
  return ['', []];
}

function isVowel(ch: string) { return 'aeiou'.includes(ch); }

// ── 단어 변환 ──
function convertWord(raw: string): string {
  const word = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return raw;

  // 빈출 예외 단어 사전
  const EXCEPTIONS: Record<string, string> = {
    'the': '더', 'a': '어', 'an': '앤', 'i': '아이',
    'you': '유', 'your': '유어', 'my': '마이', 'me': '미',
    'he': '히', 'she': '쉬', 'we': '위', 'they': '데이',
    'is': '이즈', 'are': '아', 'was': '와즈', 'were': '워',
    'do': '두', 'does': '더즈', 'did': '디드',
    'have': '해브', 'has': '해즈', 'had': '해드',
    'to': '투', 'of': '오브', 'in': '인', 'on': '온', 'at': '앱',
    'for': '포', 'with': '위드', 'from': '프롬',
    'one': '원', 'two': '투', 'three': '쓰리',
    'this': '디스', 'that': '덱', 'what': '왔',
    'not': '댋', 'no': '노', 'yes': '예스',
    'can': '캔', 'could': '쿠드', 'would': '우드', 'should': '슈드',
    'will': '위달', 'go': '고', 'come': '컴',
    'like': '라익', 'love': '러브', 'know': '노',
    'here': '히어', 'there': '데어',
    'good': '굿', 'great': '그레잇', 'much': '머치',
    'very': '베리', 'also': '올소', 'just': '저스트',
    'thank': '딱크', 'thanks': '딱크스', 'please': '플리즈',
    'hello': '헬로', 'hi': '하이',
    'nice': '나이스', 'beautiful': '뷰티풀',
    'everyone': '에브리원', 'everything': '에브리딱',
    'around': '어라운드', 'about': '어바웃',
    'because': '비커즈', 'before': '비포',
    'people': '피플', 'world': '월드',
    'make': '메이크', 'take': '테이크', 'give': '기브',
    'think': '딱크', 'let': '렛', 'right': '라잇',
    'naked': '네이키드', 'dance': '댄스', 'chant': '찬트',
  };
  if (EXCEPTIONS[word]) return EXCEPTIONS[word];

  // 끝의 silent-e 감지: consonant + e (끝) → e 무시
  const silentE = word.length > 2 && word.endsWith('e') && !isVowel(word[word.length - 2]);
  const w = silentE ? word.slice(0, -1) : word;

  const syllables: string[] = [];
  let i = 0;

  while (i < w.length) {
    // 1) 자음(onset) 소비
    const [onPat, onKor] = getOnset(w, i);
    i += onPat.length;

    // 특수: 'qu' → ㅋ + 우 삽입
    if (onPat === 'qu') {
      syllables.push(compose('ㅋ', 'ㅜ'));
    }

    // 2) 모음(vowel) 소비
    const [vowPat, vowKors] = getVowel(w, i);
    if (vowPat) {
      i += vowPat.length;

      // ng 특수처리
      if (i + 1 < w.length && w[i] === 'n' && w[i + 1] === 'g') {
        // ng: ㅇ 받침
        syllables.push(compose(onPat === 'qu' ? 'ㅇ' : onKor, vowKors[0], 'ㅇ'));
        i += 2;
        for (let vi = 1; vi < vowKors.length; vi++) syllables.push(compose('ㅇ', vowKors[vi]));
        continue;
      }

      // 3) 받침(coda) 검사
      let coda = '';
      if (i < w.length && !isVowel(w[i])) {
        // 다음 글자가 자음
        const nextIsEnd = i + 1 >= w.length;
        const nextNextIsConsonant = i + 1 < w.length && !isVowel(w[i + 1]);
        if (nextIsEnd || nextNextIsConsonant) {
          // 받침으로 사용
          const ch = w[i];
          if (CODAS[ch]) { coda = CODAS[ch]; i++; }
        }
        // 그 외: 자음은 다음 음절의 초성 → 받침 없음
      }

      // 첫 번째 중성으로 음절 조합
      const firstCho = onPat === 'qu' ? 'ㅇ' : onKor;
      if (vowKors.length === 1) {
        syllables.push(compose(firstCho, vowKors[0], coda));
      } else {
        // 다중 중성: 첫 번째에 초성, 나머지는 ㅇ 초성
        syllables.push(compose(firstCho, vowKors[0]));
        for (let vi = 1; vi < vowKors.length - 1; vi++) {
          syllables.push(compose('ㅇ', vowKors[vi]));
        }
        syllables.push(compose('ㅇ', vowKors[vowKors.length - 1], coda));
      }
    } else {
      // 모음 없음 → 자음 단독: +ㅡ
      if (onKor && onKor !== 'ㅇ') {
        syllables.push(compose(onKor, 'ㅡ'));
      } else if (i < w.length) {
        i++; // 알 수 없는 문자 스킵
      }
    }
  }

  return syllables.join('');
}

/** 영어 텍스트 → 한글 발음 변환 */
export function englishToKorean(text: string): string {
  return text
    .split(/(\s+|[^a-zA-Z]+)/)
    .map(part => /^[a-zA-Z]+$/.test(part) ? convertWord(part) : part)
    .join('');
}
