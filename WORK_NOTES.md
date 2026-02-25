# YouTube Scribe — 작업 노트

---

## 2025-02-25: 3단 레이아웃 + 성능 최적화

### 1. 3단 레이아웃 구현

**변경 파일:** `App.tsx`, `index.css`

#### 레이아웃 구조
```
[ 왼쪽 패널 (400px) ]  [ 가운데 (1fr) ]  [ 오른쪽 패널 (300px) ]
  입력/검색/컨트롤       비디오+트랜스크립트     클립 다운로드/구간조정
```

#### CSS 핵심
```css
.main-content {
  grid-template-columns: 400px 1fr;       /* 기본 2단 */
}
.main-content.has-clip-panel {
  grid-template-columns: 400px 1fr 300px;  /* 3단 */
}
```

- `has-clip-panel` 클래스는 `hasResult`가 true일 때 항상 적용
- clip-panel은 구간 미선택 시 빈 상태 안내, 선택 시 클립 컨트롤 표시

---

### 2. 접이식(아코디언) 재생 컨트롤

**목적:** 왼쪽 패널에 요소가 많아 검색 결과가 안 보이는 문제 해결

**구현:**
- `playCtrlOpen` state 추가 (기본 `false` = 접힘)
- 헤더 클릭 시 `AnimatePresence`로 부드럽게 펼침/접힘
- chevron 아이콘이 열림/닫힘 방향 표시 (CSS `rotate` 전환)

```css
.collapse-chevron { transform: rotate(-90deg); }
.collapse-chevron.open { transform: rotate(0deg); }
```

---

### 3. 싱크 조정/구간 간격 UI 정리

- `sync-adjust-bar`와 `multi-range-gap-row` 스타일 통일
- 공통 적용: `background: var(--surface-1)`, `border: 1px solid var(--border-strong)`, `border-radius: var(--radius-md)`
- `flex-wrap: wrap` 적용으로 좁은 패널에서 버튼 잘림 방지

---

### 4. 성능 최적화 (핵심)

#### 문제 원인 분석
App 컴포넌트가 ~2100줄 단일 파일. `renderedSegments` useMemo가 수백~수천 개 세그먼트를 렌더링하는데, **deps에 불필요한 상태가 포함**되어 있어서 모드 토글마다 전체 재계산 발생.

#### 최적화 원칙

| 상황 | 방식 | 이유 |
|---|---|---|
| 빈번한 시각적 변경 (active 하이라이트) | **DOM 직접 조작** (ref + classList) | 렌더링 0회, 즉시 반영 |
| CSS 클래스 토글 (drag-mode, seek-mode) | **부모 클래스 + CSS 자손 선택자** | 개별 요소 재렌더링 불필요 |
| 이벤트 핸들러에서 현재 상태 읽기 | **ref로 동기 참조** | 콜백 재생성 방지 → deps 감소 |
| 구조적 변경 (컴포넌트 추가/제거) | **React 상태** (setState) | React의 본래 역할 |

#### 적용 내역

##### 4-1. isDragMode / isSeekMode → ref
```tsx
const isDragModeRef = useRef(false);
const isSeekModeRef = useRef(false);
isDragModeRef.current = isDragMode;  // 매 렌더마다 동기화
isSeekModeRef.current = isSeekMode;
```
- `handleDragStart`, `handleDragEnter`, `handleDragEnd`에서 ref로 읽기
- 콜백 deps에서 `isDragMode`, `isSeekMode` 제거
- `drag-mode`/`seek-mode` 클래스는 부모 `transcript-scroll`에 적용

##### 4-2. interactionMode / playbackOption / videoId → ref
```tsx
const interactionModeRef = useRef(interactionMode);
const playbackOptionRef = useRef(playbackOption);
const videoIdRef = useRef(videoId);
```
- `openYouTubeAtTime` 콜백 deps: `[interactionMode, playbackOption, videoId]` → `[]`
- 검색/재생 모드 전환 시 renderedSegments 재계산 방지

##### 4-3. loopMode / showTranslation → 부모 CSS 클래스
```tsx
// 이전: 각 세그먼트에 인라인 style
style={{ display: loopMode ? '' : 'none' }}

// 이후: 부모에 클래스 추가 + CSS 규칙
<div className={`transcript-scroll ... ${loopMode ? ' loop-mode' : ''}`}>
```
```css
.seg-check { display: none; }
.loop-mode .seg-check { display: block; }

.seg-translation { display: none; }
.show-translation .seg-translation { display: block; }
```

##### 4-4. activeSegIdx → DOM 직접 조작 (가장 큰 효과)
```tsx
const updateActiveSegDom = useCallback((newIdx: number) => {
  const prev = activeSegIdxRef.current;
  if (prev === newIdx) return;
  if (prev >= 0) segmentRefs.current[prev]?.classList.remove('active');
  if (newIdx >= 0) segmentRefs.current[newIdx]?.classList.add('active');
  activeSegIdxRef.current = newIdx;
}, []);
```
- **이전:** 50ms 인터벌 → `setActiveSegIdx()` → 초당 20회 전체 세그먼트 재렌더링
- **이후:** ref + classList → 렌더링 0회

#### renderedSegments deps 변화
```
이전: [segments, activeSegIdx, searchResults, checkedSegs, isDragMode, isSeekMode,
       loopMode, searchQuery, transcript, showTranslation, translations,
       handleDragStart, handleDragEnter, handleSegToggle, openYouTubeAtTime,
       formatTimestamp, highlightText]

이후: [segments, searchResults, checkedSegs, searchQuery, transcript, translations,
       handleDragStart, handleDragEnter, handleSegToggle, openYouTubeAtTime,
       formatTimestamp, highlightText]

제거된 deps: activeSegIdx, isDragMode, isSeekMode, loopMode, showTranslation
```

#### DOM 직접 조작 vs React 상태 — 판단 기준

| 기준 | DOM 직접 조작 | React 상태 |
|---|---|---|
| **변경 빈도** | 높음 (50ms 간격 등) | 낮음 (사용자 액션) |
| **변경 내용** | CSS 클래스 토글만 | JSX 구조 변경 |
| **성능 영향** | 렌더링 0회 | 전체 재렌더링 |
| **디버깅** | DevTools에서 추적 어려움 | React DevTools로 쉽게 |
| **예측 가능성** | DOM과 React 비동기화 위험 | 항상 동기화 |

**결론:** "CSS 클래스 하나 토글"처럼 단순한 시각적 변경은 DOM 직접 조작이 압도적으로 유리. 구조적 변경(컴포넌트 추가/제거)은 React 상태가 적합.

---

### 5. 향후 고려사항

- **컴포넌트 분리:** App.tsx가 2100줄로 거대함. LeftPanel, RightPanel, ClipPanel 등으로 분리하면 각 패널의 상태 변경이 다른 패널에 영향 주지 않음
- **React.memo:** 분리된 컴포넌트에 memo 적용하면 추가 최적화 가능
- **가상 스크롤:** 세그먼트가 수천 개일 때 `react-window` 등으로 뷰포트 내 요소만 렌더링
