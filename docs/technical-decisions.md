# YouTube Scribe — 기술 결정 기록 (Technical Decision Records)

이 문서는 개발 중에 내린 주요 기술적 결정과 그 이유를 기록합니다.
"왜 이렇게 만들었는가"를 미래의 개발자(혹은 미래의 나)가 이해할 수 있도록 작성합니다.

---

## 1. 구간반복: URL 파라미터 방식 → IFrame API 방식으로 변경

### 결정
검색 결과 클릭 시 구간반복 모드에서는 새 탭을 열지 않고,
앱 내부에 YouTube IFrame API를 이용한 `LoopPlayer` 컴포넌트를 렌더링한다.

### 이유
YouTube URL 파라미터(`&start=`, `&end=`, `&loop=1`)는 **YouTube 웹사이트에서 무시**된다.

```
# 이 URL은 구간반복이 작동하지 않음
https://www.youtube.com/watch?v=VIDEO_ID&start=80&end=95&loop=1&playlist=VIDEO_ID
```

- `loop=1`, `playlist=` 파라미터는 YouTube embed(`/embed/`) 전용이며, 일반 watch URL에는 적용되지 않음
- 설령 embed URL로 열어도 `start` ~ `end` 구간만 loop하는 기능은 YouTube 자체적으로 지원하지 않음 (전체 영상이 loop됨)

### 해결책: IFrame API + JavaScript 제어
YouTube IFrame Player API를 사용해 JavaScript로 직접 재생 시간을 감시한다:

```typescript
// 150ms마다 현재 재생 시간 체크
setInterval(() => {
  const currentTime = player.getCurrentTime();
  if (currentTime >= end) {
    player.seekTo(start, true); // start로 강제 이동
    player.playVideo();
  }
}, 150);
```

### 트레이드오프
| 항목 | 새 탭 (URL 방식) | 앱 내장 (IFrame API) |
|------|-----------------|---------------------|
| 구간반복 동작 | ❌ 불가 | ✅ 가능 |
| 새 탭 열림 | ✅ | ❌ (앱 내에서 표시) |
| 전체화면 등 YouTube 기능 | ✅ 모두 가능 | ✅ controls=1로 대부분 가능 |

---

## 2. IFrame API와 Same Origin Policy(SOP)

### 결론: SOP 관련 설정 불필요

YouTube IFrame API는 SOP를 위반하지 않으며, 별도 설정 없이 동작한다.

### 상세 설명

SOP(Same Origin Policy)는 **JavaScript가 다른 출처의 iframe 내부 DOM에 직접 접근하는 것**을 차단한다.
그러나 YouTube IFrame API는 이 제한을 우회하도록 설계되어 있다:

```
우리 앱 (localhost:5173)
       ↕  postMessage (브라우저 허용 API)
YouTube iframe (www.youtube.com)
```

- `window.YT.Player`가 내부적으로 `window.postMessage()`를 사용해 YouTube iframe과 통신
- `postMessage`는 브라우저가 **명시적으로 cross-origin 통신을 허용**하기 위해 만든 Web API
- YouTube 서버는 `X-Frame-Options: ALLOW` (또는 미설정)이므로 embed 자체는 허용됨

### 프로젝트 내 보안 관련 설정 위치

| 설정 | 파일 | 목적 |
|------|------|------|
| CORS 허용 | `backend/main.py` (`CORSMiddleware`) | 프론트엔드(5173) → 백엔드(8000) fetch 허용 |
| iframe 통신 | YouTube IFrame API 내부 | 우리가 설정할 것 없음 (postMessage 사용) |
| iframe 임베드 허용 | YouTube 서버 정책 | 우리가 설정할 것 없음 |

---

## 3. playerVars에 `end` 파라미터를 제거한 이유

### 결정
`LoopPlayer`의 `playerVars`에 `end`를 포함하지 않는다.

```typescript
// ❌ 하지 않는 방식
playerVars: { start, end, autoplay: 1 }

// ✅ 실제 방식
playerVars: { start, autoplay: 1 }
```

### 이유
`playerVars.end`를 사용하면 `end` 시점에 플레이어가 **state=2 (일시정지)** 로 전환된다.
setInterval 루프에서는 `state === 0 (종료)` 조건으로만 감지하면 이 pause를 놓쳐서 반복이 멈춘다.

### 해결책
`end`를 `playerVars`에서 제거하고, JavaScript interval만으로 시간 비교하여 제어한다:

```typescript
// YT.PlayerState: -1=시작안됨, 0=종료, 1=재생중, 2=일시정지, 3=버퍼링
if (currentTime >= end || state === 0 || (state === 2 && currentTime >= end - 0.5)) {
  player.seekTo(start, true);
  player.playVideo();
}
```

---

## 4. TXT 다운로드: blob URL 대신 data URI 사용

### 결정
파일 다운로드 시 `URL.createObjectURL(blob)` 대신 `FileReader.readAsDataURL()`을 사용한다.

### 이유
Chrome 브라우저의 일부 보안 정책에서 `blob:` URL이 차단되는 경우가 있다.
`data:` URI 방식은 brower 정책에 관계없이 안정적으로 동작한다.

```typescript
const reader = new FileReader();
reader.onload = () => {
  const a = document.createElement('a');
  a.href = reader.result as string; // data:text/plain;base64,...
  a.download = 'transcript.txt';
  a.click();
};
reader.readAsDataURL(blob);
```

---

## 5. UTF-8 BOM 추가

### 결정
TXT 파일 저장 시 파일 내용 앞에 BOM(`\uFEFF`)을 추가한다.

### 이유
Windows의 메모장(Notepad)은 BOM이 없는 UTF-8 파일을 읽을 때 한글이 깨진다.
BOM을 추가하면 메모장이 파일 인코딩을 UTF-8로 자동 인식한다.

```typescript
const bom = '\uFEFF';
const blob = new Blob([bom + content], { type: 'text/plain;charset=utf-8' });
```

---

## 6. Whisper 사용 여부를 사용자에게 확인하는 이유

### 결정
YouTube 자막이 없는 영상에서는 즉시 Whisper를 실행하지 않고, 모달로 사용자에게 먼저 동의를 받는다.

### 이유
- Whisper 처리는 영상 다운로드 + 오디오 변환 + AI 음성인식을 거치므로 **수 분이 소요**될 수 있음
- 사용자가 대기 시간을 인지하지 못한 채 오래 기다리면 UX가 나빠짐
- 미리 "시간이 걸린다"는 안내와 동의를 받아 기대치를 설정함

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|----------|
| 2026-02-23 | 구간반복 방식 URL → IFrame API로 전환 |
| 2026-02-23 | playerVars에서 `end` 파라미터 제거 |
| 2026-02-23 | LoopPlayer를 자막 텍스트 위로 이동 |
| 2026-02-23 | 새 URL 검색 시 loopSegment 초기화 추가 |
