// ============================================================
// App.tsx — YouTube Scribe 메인 컴포넌트
//
// 주요 기능:
//   1. YouTube URL 입력 → 백엔드(/transcribe)에 자막 추출 요청
//   2. 자막이 없는 영상의 경우 사용자에게 Whisper 사용 여부 확인
//   3. 추출된 자막 텍스트 표시, 복사, 다운로드(TXT)
//   4. 자막 내 키워드 검색 및 결과 하이라이트
//   5. 구간반복 모드: 검색 결과 클릭 시 해당 구간을 앱 내 플레이어로 반복 재생
// ============================================================

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
// lucide-react: 아이콘 라이브러리
import { Youtube, Send, Copy, Download, Loader2, FileText, CheckCircle2, Search, Clock, RotateCcw } from 'lucide-react';
// framer-motion: 애니메이션(페이드인, 슬라이드 등)
import { motion, AnimatePresence } from 'framer-motion';
// axios: HTTP 클라이언트 (백엔드 API 호출)
import axios from 'axios';
// @romanize/korean: 한글 → 로마자 음역
import { romanize } from '@romanize/korean';
// engToKor: 영어 → 한글 발음 변환
import { englishToKorean } from './engToKor';
// fuse.js: 유사 문자열 검색 (오타/띄어쓰기 허용)
import Fuse from 'fuse.js';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import MinimapPlugin from 'wavesurfer.js/dist/plugins/minimap.esm.js';

// ─── 한글 자모 분해 (오타/미완성 입력 대응) ─────────────────────────
const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const MEDIALS  = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const FINALS   = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

function decomposeKorean(str: string): string {
  let result = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const offset = code - 0xAC00;
      result += INITIALS[Math.floor(offset / 588)];
      result += MEDIALS[Math.floor((offset % 588) / 28)];
      const fi = offset % 28;
      if (fi !== 0) result += FINALS[fi];
    } else {
      result += ch;
    }
  }
  return result;
}

// ─── 전역 타입 선언 ────────────────────────────────────────────────
// YouTube IFrame API는 window.YT 전역 객체를 통해 제공됨
// TypeScript가 해당 전역 변수를 인식하도록 타입을 확장
declare global {
  interface Window {
    YT: any;                              // YouTube IFrame Player API 객체
    onYouTubeIframeAPIReady: () => void;  // API 로드 완료 시 자동 호출되는 콜백
  }
}


// ================================================================
// LoopPlayer 컴포넌트
//
// 역할:
//   - YouTube IFrame API를 이용해 특정 구간(start~end)을 무한 반복 재생
//   - start/end를 useRef로 관리하여 재생 중에도 플레이어 재생성 없이 실시간 구간 변경 가능
//     → "재생 시작 후 구간 조정" UX를 지원 (조정 즉시 다음 loop부터 반영)
//
// Props:
//   videoId        - YouTube 영상 ID (URL에서 추출된 11자리 문자열)
//   start          - 반복 시작 시간 (초 단위 정수): 변경 시 플레이어 재생성 없이 반영
//   end            - 반복 종료 시간 (초 단위 정수): 변경 시 플레이어 재생성 없이 반영
//   onClose        - 플레이어 닫기 버튼 클릭 핸들러
//   formatTimestamp - 초 → "M:SS" 형식 변환 함수 (App에서 내려받음)
// ================================================================
function LoopPlayer({
  videoId,
  start,
  end,
  onClose,
  formatTimestamp,
  onPlayerReady,
  playbackMode = 'loop',
}: {
  videoId: string;
  start: number;
  end: number;
  onClose: () => void;
  formatTimestamp: (s: number) => string;
  onPlayerReady?: (player: any) => void;
  // playbackMode: LoopPlayer 내부의 구간 경계 감시 동작을 결정
  //   - 'loop': start~end 구간을 무한 반복 (end 도달 시 start로 seekTo)
  //   - 'once': start~end 구간을 1번만 재생 후 일시정지
  //   - 'none': 구간 경계를 감시하지 않음 (자유 재생)
  //             → 지점 재생(isSeekMode) 중이거나, 다중 구간(multiRange) 모드에서 사용
  //             → 다중 구간의 경우 별도 useEffect가 구간 전환을 직접 처리
  playbackMode?: 'loop' | 'once' | 'none';
}) {
  // YouTube IFrame API가 교체할 실제 DOM div를 참조
  const containerRef = useRef<HTMLDivElement>(null);
  // YT.Player 인스턴스 참조 (seekTo, playVideo 등 메서드 호출에 사용)
  const playerRef = useRef<any>(null);
  // setInterval 식별자 참조 (cleanup 시 clearInterval에 사용)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // start/end를 ref로 저장:
  //   - 인터벌 콜백(클로저)은 마운트 당시의 값만 캡처하므로 ref를 사용해 항상 최신값 참조
  //   - 사용자가 구간을 실시간 조정할 때 플레이어를 재생성하지 않아 영상이 끊기지 않음
  const startRef = useRef(start);
  const endRef = useRef(end);

    // start/end props가 바뀌면 ref만 업데이트 (플레이어 재생성 없음)
  useEffect(() => {
    const prevStart = startRef.current;
    startRef.current = start;
    endRef.current = end;

    const player = playerRef.current;
    // playbackMode가 none이면 구간 제한 없음 → seekTo 하지 않음
    // (지점 재생 등으로 loopConfig가 해제될 때 영상이 0초로 돌아가는 것 방지)
    if (playbackMode === 'none' || !player?.getCurrentTime) return;

    const t = player.getCurrentTime();
    const isNewClick = start !== prevStart;
    const isOutOfBounds = playbackMode === 'loop' && (t < start || t >= end);

    if (isNewClick || isOutOfBounds) {
      player.seekTo(start, true);
      player.playVideo();
    }
  }, [start, end, playbackMode]);

  // ── 구간 감시: 스마트 setTimeout 체인 ──────────────────────────
  // 종료까지 남은 시간을 계산하여 정확한 시점에만 감지 → API 호출 최소화
  useEffect(() => {
    if (playbackMode === 'none') return;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const check = () => {
      if (cancelled) return;
      const player = playerRef.current;
      if (!player?.getCurrentTime) { timerId = setTimeout(check, 500); return; }

      const state = player.getPlayerState?.();
      if (state !== 1) { timerId = setTimeout(check, 300); return; } // 재생 중 아니면 느리게

      const currentTime = player.getCurrentTime();
      const s = startRef.current;
      const e = endRef.current;
      if (e <= s || e <= 0.1) { timerId = setTimeout(check, 500); return; }

      const remaining = e - currentTime;

      if (remaining <= 0.05) {
        // 종료 도달 → 액션
        if (playbackMode === 'loop') {
          player.seekTo(s, true);
          player.playVideo();
          timerId = setTimeout(check, 200); // 루프 재시작 후 약간 대기
        } else if (playbackMode === 'once') {
          player.pauseVideo();
          player.seekTo(e, true);
          // once 모드 종료 → 타이머 중단
          return;
        }
      } else if (remaining <= 1) {
        // 종료 1초 이내 → 정밀 타이밍
        timerId = setTimeout(check, Math.max(20, (remaining - 0.05) * 1000));
      } else {
        // 여유 있음 → 느리게 체크
        timerId = setTimeout(check, Math.min(500, (remaining - 1) * 1000));
      }
    };

    check();

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [playbackMode, start, end]);

  // ── YT.Player 인스턴스 생성 ───────────────────────────────
  useEffect(() => {
    let destroyed = false;
    const createPlayer = () => {
      if (destroyed || !containerRef.current) return;

      playerRef.current = new window.YT.Player(containerRef.current, {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          start: startRef.current, // 초기 재생 시작 위치 (이후 변경은 ref+interval 처리)
          autoplay: 1,
          controls: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          // end를 playerVars에 넣지 않음 → state=2(pause) 문제를 피하고 interval로만 제어
        },
        events: {
          onReady: (e: any) => {
            e.target.seekTo(startRef.current, true);
            e.target.playVideo();
            onPlayerReady?.(e.target); // App으로 YT.Player 인스턴스 공유
          },
          onStateChange: (e: any) => {
            // 영상이 자연 종료(state=0)된 경우: 반복 재생 모드일 때만 처음으로 되돌림
            if (e.data === 0 && playbackMode === 'loop') {
              e.target.seekTo(startRef.current, true);
              e.target.playVideo();
            }
          },
        },
      });
    };

    // ── YouTube IFrame API 로드 ────────────────────────────────
    const loadAPI = () => {
      if (window.YT?.Player) {
        createPlayer();
      } else {
        // API 스크립트 중복 삽입 방지
        if (!document.getElementById('yt-iframe-api')) {
          const tag = document.createElement('script');
          tag.id = 'yt-iframe-api';
          tag.src = 'https://www.youtube.com/iframe_api';
          document.head.appendChild(tag);
        }
        window.onYouTubeIframeAPIReady = createPlayer;
      }
    };

    loadAPI();

    // ── cleanup: 컴포넌트 unmount 시 ───────────────────────────
    return () => {
      destroyed = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      try { playerRef.current?.destroy(); } catch (_) {}
    };
  }, [videoId]); // videoId가 바뀔 때만 플레이어 재생성; start/end는 ref로 처리

  // ── LoopPlayer 렌더링 ──────────────────────────────────────────
  return (
    <div className="loop-player-wrap">
      {/* 상단 상태 표시줄: 루프 인 경우에만 표시 (영상 레이어 위에 띄움) */}
      <AnimatePresence>
        {playbackMode === 'loop' && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="loop-player-bar"
          >
            <span className="loop-player-label">
              <RotateCcw style={{ width: 13, height: 13, animation: 'spin 2s linear infinite', flexShrink: 0 }} />
              구간 반복 중: {formatTimestamp(start)} ~ {formatTimestamp(end)}
            </span>
            <button className="loop-player-close" onClick={onClose}>✕ 닫기</button>
          </motion.div>
        )}
        {playbackMode === 'once' && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="loop-player-bar once"
            style={{ background: 'rgba(34, 197, 94, 0.85)' }} // 1번 재생은 초록색 계열로 구분
          >
            <span className="loop-player-label">
              <svg style={{ width: 13, height: 13, flexShrink: 0 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              1번 재생 모드 (구간 종료 시 중지)
            </span>
            <button className="loop-player-close" onClick={onClose}>✕ 닫기</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* YouTube IFrame API가 교체할 노드 - 별도 컨테이너로 격리하여 React의 DOM 조작과 충돌 방지 */}
      <div className="player-stage">
        <div ref={containerRef} className="loop-player-frame" />
      </div>
    </div>
  );
}
// ── LoopPlayer 끝 ──────────────────────────────────────────────────


// ─── 타입 정의 ────────────────────────────────────────────────────

/** 백엔드에서 반환하는 자막 세그먼트 하나의 단위 */
interface Segment {
  start: number;    // 세그먼트 시작 시간 (초, 소수점 포함)
  duration: number; // 세그먼트 지속 시간 (초)
  text: string;     // 자막 텍스트 내용
}

/** 키워드 검색 결과 단위 */
interface SearchResult {
  segment: Segment;
  matchIndex: number;
  loopStartIdx: number;
  loopEndIdx: number;
  score: number;           // 유사도 점수 (0=정확 일치, 높을수록 느슨)
}

// ─── 대본 저장/불러오기 ─────────────────────────────────────────────
const SCRIPTS_STORAGE_KEY = 'youtube-scribe-scripts';

interface SavedScript {
  id: string;
  videoId: string;
  title: string;
  segments: Segment[];
  createdAt: string;
  updatedAt: string;
}

function loadAllScripts(): SavedScript[] {
  try {
    const raw = localStorage.getItem(SCRIPTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveAllScripts(scripts: SavedScript[]) {
  localStorage.setItem(SCRIPTS_STORAGE_KEY, JSON.stringify(scripts));
}

// ================================================================
// App 컴포넌트 (메인)
// ================================================================
function App() {

  // ─── 상태(State) 정의 ──────────────────────────────────────────

  const [url, setUrl] = useState('');                 // 사용자가 입력한 YouTube URL
  const urlInputRef = useRef<HTMLInputElement>(null);  // URL 입력 필드 DOM ref (자동 포커스용)
  const [loading, setLoading] = useState(false); // 백엔드 요청 진행 중 여부 (로딩 스피너 제어)
  const [transcript, setTranscript] = useState(''); // 추출된 전체 자막 텍스트 (평문)
  const [segments, setSegments] = useState<Segment[]>([]); // 타임스탬프별 세그먼트 배열
  const originalSegmentsRef = useRef<Segment[]>([]);        // API에서 가져온 원본 대본 (되돌리기용)
  const editSnapshotRef = useRef<Segment[]>([]);             // 편집 모드 진입 시 스냅샷 (편집 취소용)
  const [segmentsVersion, setSegmentsVersion] = useState(0); // defaultValue 갱신을 위한 key 카운터
  const [videoId, setVideoId] = useState('');   // YouTube 영상 ID (URL에서 파싱, 링크 생성에 사용)
  const [error, setError] = useState('');        // 사용자에게 표시할 에러 메시지
  const [copied, setCopied] = useState(false);   // "복사됨" 피드백 표시 여부 (2초 후 자동 리셋)
  const [localMediaUrl, setLocalMediaUrl] = useState('');  // 로컬 업로드 파일 재생 URL
  const [localFileName, setLocalFileName] = useState('');  // 업로드된 파일명
  const [uploadProgress, setUploadProgress] = useState(''); // 업로드/전사 진행 상태 메시지
  const [transcribeProgress, setTranscribeProgress] = useState(0); // 전사 진행률 (0~100)
  const [isDragOverUpload, setIsDragOverUpload] = useState(false); // 드래그 오버 상태
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [markIn, setMarkIn] = useState<number | null>(null);     // 수동 자막: 시작(In) 마커 시간
  const [markOut, setMarkOut] = useState<number | null>(null);   // 수동 자막: 끝(Out) 마커 시간
  const wavesurferRef = useRef<WaveSurfer | null>(null);         // WaveSurfer 인스턴스
  const waveformContainerRef = useRef<HTMLDivElement>(null);      // 파형 DOM 컨테이너
  const wsRegionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const wsTimelineRef = useRef<ReturnType<typeof TimelinePlugin.create> | null>(null);
  const wsMinimapRef = useRef<ReturnType<typeof MinimapPlugin.create> | null>(null);

  // 줌 레벨(pxPerSec)에 따른 타임라인 간격 계산 헬퍼
  const getTimelineIntervals = useCallback((pxPerSec: number) => {
    if (pxPerSec >= 100) return { timeInterval: 0.5, primaryLabelInterval: 2 };
    if (pxPerSec >= 50)  return { timeInterval: 1,   primaryLabelInterval: 5 };
    if (pxPerSec >= 20)  return { timeInterval: 5,   primaryLabelInterval: 10 };
    if (pxPerSec >= 5)   return { timeInterval: 10,  primaryLabelInterval: 30 };
    return { timeInterval: 30, primaryLabelInterval: 60 };
  }, []);

  /** Timeline 플러그인을 (재)생성 — 줌 변경 시 호출 */
  const recreateTimeline = useCallback((ws: WaveSurfer, pxPerSec: number) => {
    // 기존 타임라인 제거
    if (wsTimelineRef.current) {
      try { wsTimelineRef.current.destroy(); } catch { /* ignore */ }
      wsTimelineRef.current = null;
    }
    const { timeInterval, primaryLabelInterval } = getTimelineIntervals(pxPerSec);
    const tl = ws.registerPlugin(TimelinePlugin.create({
      timeInterval,
      primaryLabelInterval,
      style: { fontSize: '10px', color: 'rgba(255,255,255,0.4)' },
      secondaryLabelOpacity: 0.25,
    }));
    wsTimelineRef.current = tl;
  }, [getTimelineIntervals]);
  const [waveformReady, setWaveformReady] = useState(false);      // 파형 로딩 완료 여부
  const [waveformHeight, setWaveformHeight] = useState(64);       // 파형 높이 (px, 드래그 리사이즈)
  const [minimapHeight, setMinimapHeight] = useState(24);         // 미니맵 높이 (px)
  const [toastMessage, setToastMessage] = useState(''); // 토스트 메시지 (빈 문자열이면 숨김)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showToast = useCallback((msg: string, ms = 2000) => {
    clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(''), ms);
  }, []);

  const searchQueryRef = useRef('');  // 현재 검색어 (리렌더 없이 빠르게 참조)
  const searchInputRef = useRef<HTMLInputElement>(null);  // 검색 입력 필드 DOM ref
  const [showModePanel, setShowModePanel] = useState(false);  // 클릭 동작(검색/재생) 모드 선택 패널 표시 여부
  const [showSearchResults, setShowSearchResults] = useState(false);  // 검색 결과 리스트 패널 열림 여부
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]); // 현재 검색 결과 배열
  const [fuzzySearch, setFuzzySearch] = useState(true); // 유사 검색(fuse.js) 활성화 여부 (false = 정확 일치만)
  const [searchRange, setSearchRange] = useState(10); // 검색 결과 컨텍스트 윈도우 크기 (앞뒤 세그먼트 수)
  const [fuzzyThreshold, setFuzzyThreshold] = useState(0.3);  // 유사도 임계값 (0=정확 일치, 1=느슨)
  const [showSearchOpts, setShowSearchOpts] = useState(false);  // 검색 옵션 패널 열림 여부

  // ─── 레이아웃 리사이즈 state ─────────────────────────────────────
  interface LayoutSizes { leftWidth: number; clipWidth: number; videoRatio: number; }
  const LAYOUT_DEFAULTS: LayoutSizes = { leftWidth: 400, clipWidth: 300, videoRatio: 50 };
  const loadLayout = (): LayoutSizes => {
    try {
      const raw = localStorage.getItem('ys-layout');
      return raw ? { ...LAYOUT_DEFAULTS, ...JSON.parse(raw) } : { ...LAYOUT_DEFAULTS };
    } catch { return { ...LAYOUT_DEFAULTS }; }
  };
  const [layoutSizes, setLayoutSizes] = useState<LayoutSizes>(loadLayout); // 패널 크기 (localStorage에서 복원)
  const layoutRef = useRef(layoutSizes);                                   // 리사이즈 핸들러에서 최신값 동기 참조
  const dragRef = useRef<{ type: string; startX: number; startY: number; startVal: number } | null>(null); // 리사이즈 드래그 진행 정보

  // ─── 패널 접기/펼치기 state ───────────────────────────────────────
  const [leftCollapsed, setLeftCollapsed] = useState(() => localStorage.getItem('ys-left-collapsed') === 'true');   // 왼쪽 패널 접힘 여부 (localStorage 지속)
  const [clipCollapsed, setClipCollapsed] = useState(() => localStorage.getItem('ys-clip-collapsed') === 'true');   // 클립 패널 접힘 여부 (localStorage 지속)
  useEffect(() => { localStorage.setItem('ys-left-collapsed', String(leftCollapsed)); }, [leftCollapsed]);
  useEffect(() => { localStorage.setItem('ys-clip-collapsed', String(clipCollapsed)); }, [clipCollapsed]);

  // ─── 플로팅 비디오 state ──────────────────────────────────────────
  const [isVideoFloating, setIsVideoFloating] = useState(false);           // 비디오 플레이어 플로팅(분리) 상태 여부
  const [floatingVideoPos, setFloatingVideoPos] = useState({ x: 100, y: 100, w: 640, h: 360 }); // 플로팅 창 위치·크기
  const videoContainerRef = useRef<HTMLDivElement>(null);                   // 비디오 컨테이너 DOM ref (도킹/분리 위치 계산)
  const videoDockZoneRef = useRef<HTMLDivElement>(null);                    // 도킹 영역 DOM ref (스냅백 판단)
  const floatingDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; isDragging: boolean } | null>(null); // 플로팅 드래그 진행 정보
  const floatingResizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number; dir: string } | null>(null); // 플로팅 리사이즈 진행 정보
  // 드래그 시작 시 원본 위치 (분리 임계값 판단용)
  const videoDetachRef = useRef<{ startX: number; startY: number; originRect: DOMRect | null; isDragging: boolean }>({ startX: 0, startY: 0, originRect: null, isDragging: false });
  // 마지막 플로팅 크기 기억 (도킹→분리 시 이전 크기 유지)
  const lastFloatSizeRef = useRef<{ w: number; h: number } | null>(null);

  /** 비디오 영역 상단 바를 잡고 드래그 → 분리/도킹 */
  const handleVideoGrabStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = videoContainerRef.current?.getBoundingClientRect() ?? null;
    if (!isVideoFloating) {
      // 아직 도킹 상태: 드래그 시작, 임계값 넘으면 분리
      videoDetachRef.current = { startX: e.clientX, startY: e.clientY, originRect: rect, isDragging: true };
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing');

      // 분리 후 플로팅 드래그로 전환하기 위한 상태
      let detached = false;
      let floatStartX = 0;
      let floatStartY = 0;
      let floatPosX = 0;
      let floatPosY = 0;

      const onMove = (ev: MouseEvent) => {
        if (detached) {
          // 이미 분리됨 → 플로팅 위치 업데이트
          const newX = floatPosX + (ev.clientX - floatStartX);
          const newY = floatPosY + (ev.clientY - floatStartY);
          setFloatingVideoPos(prev => ({ ...prev, x: newX, y: newY }));
          return;
        }
        const d = videoDetachRef.current;
        if (!d.isDragging) return;
        const dx = Math.abs(ev.clientX - d.startX);
        const dy = Math.abs(ev.clientY - d.startY);
        // 40px 이상 이동하면 분리 → 리스너 유지한 채 플로팅 드래그로 전환
        if (dx > 40 || dy > 40) {
          d.isDragging = false;
          detached = true;
          const saved = lastFloatSizeRef.current;
          const r = d.originRect;
          const w = saved ? saved.w : (r ? r.width : 640);
          const h = saved ? saved.h : (r ? r.height : 360);
          floatPosX = ev.clientX - w / 2;
          floatPosY = ev.clientY - 16;
          floatStartX = ev.clientX;
          floatStartY = ev.clientY;
          setFloatingVideoPos({ x: floatPosX, y: floatPosY, w, h });
          setIsVideoFloating(true);
        }
      };
      const onUp = (ev: MouseEvent) => {
        videoDetachRef.current.isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove('is-resizing');
        // 분리된 상태에서 mouseUp → 도킹 스냅백 체크
        if (detached) {
          const dockEl = videoDockZoneRef.current;
          if (dockEl) {
            const r = dockEl.getBoundingClientRect();
            if (ev.clientX >= r.left - 60 && ev.clientX <= r.right + 60 &&
                ev.clientY >= r.top - 60 && ev.clientY <= r.bottom + 60) {
              setIsVideoFloating(false);
            }
          }
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    } else {
      // 이미 플로팅: 위치 이동
      floatingDragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: floatingVideoPos.x, startPosY: floatingVideoPos.y, isDragging: true };
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing');

      const onMove = (ev: MouseEvent) => {
        const d = floatingDragRef.current;
        if (!d?.isDragging) return;
        setFloatingVideoPos(prev => ({
          ...prev,
          x: d.startPosX + (ev.clientX - d.startX),
          y: d.startPosY + (ev.clientY - d.startY),
        }));
      };
      const onUp = (ev: MouseEvent) => {
        if (floatingDragRef.current) floatingDragRef.current.isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove('is-resizing');
        // 도킹 스냅백 체크
        const dockEl = videoDockZoneRef.current;
        if (dockEl) {
          const r = dockEl.getBoundingClientRect();
          // 드롭 위치가 도킹 영역과 겹치면 도킹
          if (ev.clientX >= r.left - 60 && ev.clientX <= r.right + 60 &&
              ev.clientY >= r.top - 60 && ev.clientY <= r.bottom + 60) {
            setIsVideoFloating(false);
          }
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
  };

  /** 플로팅 창 리사이즈 핸들러 */
  const handleFloatingResize = (dir: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startPos = { ...floatingVideoPos };
    floatingResizeRef.current = { startX: e.clientX, startY: e.clientY, startW: floatingVideoPos.w, startH: floatingVideoPos.h, dir };
    document.body.style.cursor =
      dir === 'se' ? 'nwse-resize' : dir === 'sw' ? 'nesw-resize' :
      dir === 'e' ? 'ew-resize' : dir === 'w' ? 'ew-resize' :
      dir === 's' ? 'ns-resize' : 'nwse-resize';
    document.body.style.userSelect = 'none';
    document.body.classList.add('is-resizing');

    const onMove = (ev: MouseEvent) => {
      const r = floatingResizeRef.current;
      if (!r) return;
      const dx = ev.clientX - r.startX;
      const dy = ev.clientY - r.startY;

      let newX = startPos.x;
      let newW = startPos.w;
      let newH = startPos.h;

      if (dir.includes('e')) {
        newW = Math.max(280, r.startW + dx);
      }
      if (dir.includes('w')) {
        newW = Math.max(280, r.startW - dx);
        newX = startPos.x + (r.startW - newW);
      }
      if (dir.includes('s')) {
        newH = Math.max(180, r.startH + dy);
      }

      setFloatingVideoPos(prev => ({ ...prev, x: newX, w: newW, h: newH }));
    };
    const onUp = () => {
      floatingResizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('is-resizing');
      // 리사이즈된 크기 기억
      setFloatingVideoPos(prev => {
        lastFloatSizeRef.current = { w: prev.w, h: prev.h };
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 레이아웃 변경 시 localStorage에 저장
  useEffect(() => {
    layoutRef.current = layoutSizes;
    localStorage.setItem('ys-layout', JSON.stringify(layoutSizes));
  }, [layoutSizes]);

  const handleResizeStart = (type: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const startVal = type === 'left' ? layoutSizes.leftWidth
      : type === 'clip' ? layoutSizes.clipWidth
      : layoutSizes.videoRatio;
    dragRef.current = { type, startX: e.clientX, startY: e.clientY, startVal };
    document.body.classList.add('is-resizing');

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const d = dragRef.current;
      if (d.type === 'left') {
        const newW = Math.max(250, Math.min(700, d.startVal + (ev.clientX - d.startX)));
        setLayoutSizes(prev => ({ ...prev, leftWidth: newW }));
      } else if (d.type === 'clip') {
        const newW = Math.max(200, Math.min(600, d.startVal - (ev.clientX - d.startX)));
        setLayoutSizes(prev => ({ ...prev, clipWidth: newW }));
      } else if (d.type === 'video') {
        const parent = (e.target as HTMLElement).closest('.right-panel');
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        const pct = Math.max(15, Math.min(80, ((ev.clientY - rect.top) / rect.height) * 100));
        setLayoutSizes(prev => ({ ...prev, videoRatio: pct }));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = type === 'video' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const resetLayout = () => {
    setLayoutSizes({ ...LAYOUT_DEFAULTS });
    localStorage.removeItem('ys-layout');
  };

  /** 파형 높이 드래그 리사이즈 */
  const handleWaveformResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = waveformHeight;
    document.body.classList.add('is-resizing');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      // 아래로 드래그 → 높이 증가, 위로 → 축소
      const newH = Math.max(40, Math.min(300, startH + (ev.clientY - startY)));
      setWaveformHeight(newH);
      wavesurferRef.current?.setOptions({ height: newH });
    };
    const onUp = () => {
      document.body.classList.remove('is-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ─── 대본 저장/불러오기 state ────────────────────────────────────
  const savedScriptsRef = useRef<SavedScript[]>(loadAllScripts());         // 저장된 대본 목록 (ref: 렌더 없이 빠르게 조회)
  const [showScriptsPanel, setShowScriptsPanel] = useState(false);         // 저장된 대본 목록 패널 표시 여부
  const scriptTitleRef = useRef<HTMLInputElement>(null);                    // 대본 제목 입력 필드 DOM ref
  const [activeScriptId, setActiveScriptId] = useState<string | null>(null); // 현재 편집/로드 중인 대본 ID (null = 새 대본)
  const isEditModeRef = useRef(false);                                     // 편집모드 동기 참조 (이벤트 핸들러 내에서 즉시 읽기용)
  const [isEditMode, setIsEditMode] = useState(false);                     // 자막 편집 모드 ON/OFF (타임스탬프·텍스트 직접 수정 가능)
  const [wrapEditNav, setWrapEditNav] = useState(false);                   // 편집 처음↔끝 순환 이동
  const [showEditSettings, setShowEditSettings] = useState(false);         // 편집 설정 드롭다운
  const editBtnRef = useRef<HTMLButtonElement>(null);                       // 편집 버튼 DOM ref (active 클래스 직접 토글)
  const toggleEditMode = useCallback(() => {
    isEditModeRef.current = !isEditModeRef.current;
    setIsEditMode(isEditModeRef.current);
    editBtnRef.current?.classList.toggle('active', isEditModeRef.current);
    if (isEditModeRef.current) {
      // 편집모드 진입 → 스냅샷 저장 + 자동스크롤 OFF
      editSnapshotRef.current = [...segments];
      setIsAutoScroll(false);
      isAutoScrollRef.current = false;
      rangeClickRef.current = null;
      clearRangePins();
    } else {
      // 편집모드 종료 → version 증가로 defaultValue 갱신
      setSegmentsVersion(v => v + 1);
      setShowEditSettings(false);
      showToast('✅ 편집 완료');
    }
  }, [segments, showToast]);

  /** 편집 되돌리기: 편집 모드 진입 시점의 상태로 복원 */
  const revertEdits = useCallback(() => {
    if (editSnapshotRef.current.length === 0) return;
    setSegments(editSnapshotRef.current);
    setSegmentsVersion(v => v + 1); // defaultValue 강제 갱신
  }, []);
  const [, forceScriptsUpdate] = useState(0); // 패널 목록 갱신용

  const handleSaveScript = () => {
    const title = scriptTitleRef.current?.value?.trim() || `대본 ${new Date().toLocaleString('ko')}`;
    const now = new Date().toISOString();
    const id = activeScriptId || `${videoId}_${Date.now()}`;
    const newScript: SavedScript = {
      id, videoId, title,
      segments: [...segments],
      createdAt: savedScriptsRef.current.find(s => s.id === id)?.createdAt || now,
      updatedAt: now,
    };
    const updated = activeScriptId
      ? savedScriptsRef.current.map(s => s.id === id ? newScript : s)
      : [...savedScriptsRef.current, newScript];
    saveAllScripts(updated);
    savedScriptsRef.current = updated;
    setActiveScriptId(id);
    if (scriptTitleRef.current) scriptTitleRef.current.value = title;
  };

  const handleLoadScript = (script: SavedScript) => {
    setSegments(script.segments);
    setTranscript(script.segments.map(s => s.text).join(' '));
    setActiveScriptId(script.id);
    if (scriptTitleRef.current) scriptTitleRef.current.value = script.title;
    setShowScriptsPanel(false);
  };

  const handleDeleteScript = (id: string) => {
    const updated = savedScriptsRef.current.filter(s => s.id !== id);
    saveAllScripts(updated);
    savedScriptsRef.current = updated;
    if (activeScriptId === id) setActiveScriptId(null);
    forceScriptsUpdate(n => n + 1);
  };

  // activeSegIdxRef: LoopPlayer 재생 중 현재 재생 위치에 해당하는 세그먼트 인덱스
  // -1이면 비활성 (재생 안 함 또는 세그먼트 없음)
  // DOM 직접 조작(updateActiveSegDom)으로 클래스 토글하므로 state 불필요, ref만 사용
  const activeSegIdxRef = useRef<number>(-1);

  // DOM 직접 조작으로 active 클래스 전환 (렌더링 없음)
  const updateActiveSegDom = useCallback((newIdx: number) => {
    const prev = activeSegIdxRef.current;
    if (prev === newIdx) return;
    if (prev >= 0) segmentRefs.current[prev]?.classList.remove('active');
    if (newIdx >= 0) segmentRefs.current[newIdx]?.classList.add('active');
    activeSegIdxRef.current = newIdx;
  }, []);

  // ─── 재생 모드 체계 (Mode Architecture) ──────────────────────────
  //
  // [1] interactionMode: 검색 결과/타임스탬프 클릭 시 무엇을 할지
  //     'search' = 해당 세그먼트로 스크롤 이동 (기본값)
  //     'play'   = 해당 구간을 LoopPlayer로 재생
  //
  // [2] playbackOption: interactionMode='play'일 때 재생 방식
  //     'loop'  = 앱 내 플레이어에서 구간 무한 반복
  //     'once'  = 앱 내 플레이어에서 구간 1회 재생 후 정지
  //     'popup' = 새 탭에서 YouTube 열기 (앱 내 플레이어 사용 안 함)
  //
  // [3] isSeekMode (지점 재생): ON 시 세그먼트 클릭으로 해당 위치부터 자유 재생
  //     - isDragMode(구간 재생)를 비활성화
  //     - LoopPlayer playbackMode를 'none'으로 전환 (구간 경계 무시)
  //     - loopConfig는 보존됨 → OFF 시 이전 구간으로 복귀 가능
  //
  // [4] isDragMode (구간 재생): ON 시 드래그/클릭으로 구간 선택
  //     - 구간 확정(finalizeRange) 시 loopConfig + interactionMode='play' 자동 설정
  //     - isSeekMode ON 시 자동 비활성화
  //
  // [5] loopConfig: 재생할 구간의 세그먼트 인덱스 범위
  //     - null이면 구간 미설정 → loopMode=false → LoopPlayer playbackMode='none'
  //     - 지점 재생(isSeekMode) 전환 시에도 보존되어 복귀 가능
  //
  // [6] loopMode (파생값): 앱 내 플레이어 구간 반복/1회 표시 여부
  //     = interactionMode==='play' && playbackOption!=='popup' && loopConfig!==null
  //
  // [7] LoopPlayer playbackMode 결정 (렌더 시 계산):
  //     !loopMode           → 'none' (구간 설정 없거나 popup 모드)
  //     isSeekMode          → 'none' (지점 재생 중, 구간 경계 무시)
  //     isMultiRange(2개+)  → 'none' (별도 useEffect가 구간 전환 처리)
  //     playbackOption      → 'once' | 'loop'
  //
  // [8] isMultiRangeMode: 다중 구간 모드
  //     - 드래그할 때마다 새 구간을 multiRanges[]에 추가
  //     - 2개 이상이면 별도 setInterval 로직이 순차/반복 재생 관리
  //     - LoopPlayer playbackMode='none'으로 두고 직접 seekTo/playVideo 호출
  // ──────────────────────────────────────────────────────────────────

  // segmentRefs: 각 세그먼트 DOM 요소에 대한 ref 배열 (자동 스크롤용)
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([]);

  // interactionMode: 검색 결과 클릭 시 동작 설정 ('search' | 'play')
  // - 'search': 해당 위치로 스크롤 이동만 함 (기본값)
  // - 'play': 해당 구간 재생
  const [interactionMode, setInteractionMode] = useState<'search' | 'play'>('search');

  // playbackOption: 'play' 모드일 때 재생 방식 ('loop' | 'once' | 'popup')
  // - 'loop': 앱 내 플레이어로 구간 무한 반복
  // - 'once': 앱 내 플레이어로 해당 구간만 1번 재생 후 멈춤
  // - 'popup': 새 창에서 해당 시간대 열기
  const [playbackOption, setPlaybackOption] = useState<'loop' | 'once' | 'popup'>('loop');
  // ref 동기화: 이벤트 핸들러 클로저에서 항상 최신 state를 읽을 수 있도록
  const interactionModeRef = useRef(interactionMode);   // interactionMode 동기 참조
  const playbackOptionRef = useRef(playbackOption);     // playbackOption 동기 참조
  const videoIdRef = useRef(videoId);                   // videoId 동기 참조
  interactionModeRef.current = interactionMode;
  playbackOptionRef.current = playbackOption;
  videoIdRef.current = videoId;

  // loopConfig: 구간반복 모드에서 현재 재생 중인 구간 설정
  //   - 클릭 즉시 설정되어 LoopPlayer가 바로 시작됨
  //   - 재생 중에 startOffset/endOffset을 조정하면 실시간으로 start/end가 갱신됨
  //   - null이면 플레이어 표시 안 함
  const [loopConfig, setLoopConfig] = useState<{
    matchIndex: number;  // 기준 세그먼트의 segments[] 인덱스 (검색 결과 클릭 시 설정)
    startOffset: number; // 시작을 matchIndex 기준으로 몇 세그먼트 앞으로 당길지 (0 = 클릭한 세그먼트)
    endOffset: number;   // 종료를 matchIndex 기준으로 몇 세그먼트 뒤로 늘릴지 (0 = 클릭한 세그먼트)
  } | null>(null);

  // loopMode: 앱 내 플레이어를 표시해야 하는 상태인지 여부 (loop 또는 once)
  // loopConfig가 null이면 구간 설정이 없으므로 loopMode도 false
  const loopMode = interactionMode === 'play' && (playbackOption === 'loop' || playbackOption === 'once') && loopConfig !== null;

  // loopConfig에서 파생되는 실제 start/end 시간 계산 (LoopPlayer에 전달)
  const loopSegment = loopConfig && segments.length > 0 ? (() => {
    const { matchIndex, startOffset, endOffset } = loopConfig;
    const startSegIdx = Math.max(0, matchIndex - startOffset);
    const endSegIdx   = Math.min(segments.length - 1, matchIndex + endOffset);
    const startTime   = segments[startSegIdx].start;
    // 종료 시점: 마지막 세그먼트가 아니면 다음 세그먼트의 시작 직전 사용 (겹침 방지)
    const nextSeg     = segments[endSegIdx + 1];
    const endTime     = nextSeg
      ? nextSeg.start  // 다음 세그먼트 시작 = 현재 세그먼트의 실제 종료
      : segments[endSegIdx].start + segments[endSegIdx].duration;
    return {
      start: startTime,
      end:   endTime,
      startSegIdx,
      endSegIdx,
      startSeg: segments[startSegIdx],
      endSeg:   segments[endSegIdx],
    };
  })() : null;

  const [showWhisperConfirm, setShowWhisperConfirm] = useState(false);
  // showWhisperConfirm: 자막 없는 영상에서 Whisper 사용 여부 확인 모달 표시 여부

  const [includeTimestamps, setIncludeTimestamps] = useState(false);
  // includeTimestamps: TXT 저장 시 타임스탬프 포함 여부 (true: "[0:00] 텍스트" 형식)

  const [lineBreak, setLineBreak] = useState(false);
  // lineBreak: 타임스탬프 미포함 시 세그먼트 사이 줄바꿈 여부

  const [lineBreakCount, setLineBreakCount] = useState(1);
  // lineBreakCount: 세그먼트 사이에 삽입할 빈 줄 수 (0 = 줄바꿈만, 1 = 1줄, 2 = 2줄)

  const [pendingUrl, setPendingUrl] = useState('');
  // pendingUrl: Whisper 확인 모달이 뜬 동안 임시 저장된 요청 URL

  const [checkedSegs, setCheckedSegs] = useState<Set<number>>(new Set());  // 체크된 세그먼트 인덱스 집합 (구간 반복 범위 시각적 표시)
  const checkedSegsRef = useRef<Set<number>>(new Set());                   // 동기 참조 (handleSegToggle 등에서 즉시 읽기)

  // checkedSegs DOM 동기화: 모든 세그먼트의 checked/seg-check--on 클래스 갱신
  const syncCheckedDom = useCallback((segs: Set<number>) => {
    checkedSegsRef.current = segs;
    segmentRefs.current.forEach((el, i) => {
      if (!el) return;
      const isChecked = segs.has(i);
      el.classList.toggle('checked', isChecked);
      const btn = el.querySelector('.seg-check');
      if (btn) btn.classList.toggle('seg-check--on', isChecked);
    });
  }, []);

  // ─── 언어 선택 관련 상태 ────────────────────────────────────────
  interface LangOption { code: string; name: string; label: string; is_generated: boolean; }
  const [availableLangs, setAvailableLangs] = useState<LangOption[]>([]); // 조회된 언어 목록
  const [selectedLang, setSelectedLang] = useState('');                   // 사용자가 선택한 언어 코드 ('' = 자동)
  const [langLoading, setLangLoading] = useState(false);                  // 언어 목록 로딩 중 여부
  const [langError, setLangError] = useState('');                         // 언어 조회 실패 메시지
  const [isDragMode, setIsDragMode] = useState(false);                 // 구간 재생: 드래그/클릭으로 구간 선택 모드 (지점 재생 ON 시 비활성)
  const [isMultiRangeMode, setIsMultiRangeMode] = useState(false);     // 다중 구간 모드 (드래그할 때마다 새 구간 추가)
  const [multiRanges, setMultiRanges] = useState<{startIdx: number; endIdx: number; repeatCount: number}[]>([]); // 다중 구간 목록 (시작/끝 인덱스 + 반복 횟수)
  const [rangeGap, setRangeGap] = useState(1);                         // 다중 구간 사이 간격 (초)
  const [activeMultiRangeIdx, setActiveMultiRangeIdx] = useState(0);   // 다중 구간: 현재 재생 중인 구간 번호
  const [dragStartIdx, setDragStartIdx] = useState<number | null>(null); // 드래그 시작 세그먼트 인덱스 (null = 드래그 중 아님)
  // ref 동기화: state 업데이트 비동기 지연 없이 드래그 핸들러에서 즉시 읽기 위한 동기 참조
  const dragStartIdxRef   = useRef<number | null>(null);               // 드래그 시작 인덱스 동기 참조
  const dragCurrentIdxRef = useRef<number | null>(null);               // 드래그 현재 인덱스 동기 참조
  const rangeClickRef     = useRef<number | null>(null);               // 클릭 2회 구간 설정: 첫 번째 클릭 위치 (null = 미설정)
  const [isTrackingMode, setIsTrackingMode] = useState(true);          // 위치 트래킹: 현재 재생 위치를 하이라이트할지 여부
  const [isAutoScroll, setIsAutoScroll] = useState(true);              // 자동 스크롤: 재생 위치로 자동 스크롤 ON/OFF (트래킹과 독립)
  const isAutoScrollRef = useRef(true);                                // 자동 스크롤 동기 참조
  const transcriptScrollRef = useRef<HTMLDivElement>(null);            // 자막 목록 스크롤 컨테이너 DOM ref
  const userScrollingRef = useRef(false);                              // 사용자 휠/스크롤바 스크롤 중 플래그 (scrollIntoView 억제)
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);  // 휠 스크롤 종료 감지 타이머
  const programmaticScrollRef = useRef(false);                         // scrollIntoView 호출 중 플래그 (사용자 스크롤과 구분)

  /** 휠 스크롤: scrollIntoView 억제 (scroll 이벤트가 가시성 판단) */
  const handleTranscriptWheel = useCallback(() => {
    userScrollingRef.current = true;
    programmaticScrollRef.current = false;
    if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    wheelTimeoutRef.current = setTimeout(() => { userScrollingRef.current = false; }, 500);
  }, []);

  // 자동 스크롤 자동켜기: 새 재생 구간 설정 시 자동 스크롤을 다시 ON
  const [autoScrollReEnable, setAutoScrollReEnable] = useState(true);  // 새 구간 재생 시 자동 스크롤을 다시 ON 할지 여부
  const autoScrollReEnableRef = useRef(true);                          // 동기 참조 (useEffect 내에서 즉시 읽기)
  const [reEnableTrigger, setReEnableTrigger] = useState(0);           // 재생 액션 발생 카운터 (변경 시 자동스크롤 재활성화 트리거)

  // loopConfig 변경 OR 지점재생 클릭 시 자동 스크롤 재활성화
  useEffect(() => {
    if (reEnableTrigger > 0 && autoScrollReEnableRef.current && !isAutoScrollRef.current && !isEditModeRef.current) {
      // 이전 재생 위치로 되돌아가지 않도록 잠시 scrollIntoView 억제
      userScrollingRef.current = true;
      isAutoScrollRef.current = true;
      setIsAutoScroll(true);
      setTimeout(() => { userScrollingRef.current = false; }, 300);
    }
  }, [reEnableTrigger]);

  // loopConfig 변경 시도 트리거 증가
  useEffect(() => {
    if (loopConfig) setReEnableTrigger(v => v + 1);
  }, [loopConfig]);

  const [trackingOffset, setTrackingOffset] = useState(0.3);             // 트래킹 싱크 오프셋 (초, 기본값 0.3s 빠르게)
  const [timestampPrecision, setTimestampPrecision] = useState(0);       // 타임스탬프 정밀도 (0:초, 1:0.1s, 2:0.01s, 3:ms)
  const [isSeekMode, setIsSeekMode] = useState(false);                  // 지점 재생 모드: 세그먼트 클릭 시 해당 위치부터 자유 재생 (ON 시 구간 재생 비활성)
  const isDragModeRef = useRef(false);                                  // isDragMode 동기 참조 (드래그 핸들러 내에서 즉시 확인)
  const isSeekModeRef = useRef(false);                                  // isSeekMode 동기 참조 (클릭 핸들러 내에서 모드 분기)
  // ref ↔ state 동기화: 렌더마다 ref를 최신 state로 갱신
  isDragModeRef.current = isDragMode;
  isSeekModeRef.current = isSeekMode;
  const [playCtrlOpen, setPlayCtrlOpen] = useState(true);              // 재생 컨트롤 접이식 열림 상태
  const [showTranslation, setShowTranslation] = useState(false);         // 발음 자막 편집 패널 표시
  const [translations, setTranslations] = useState<Record<number, string>>({}); // 세그먼트별 발음 텍스트
  const translationsRef = useRef<Record<number, string>>({});              // 동기 참조 (클립 다운로드 시 즉시 읽기)
  translationsRef.current = translations;                                  // 렌더마다 최신값 동기화
  const [clipQuality, setClipQuality] = useState<'360'|'480'|'720'|'1080'|'best'|'vertical'>('720'); // 클립 다운로드 해상도
  const [burnSubs,   setBurnSubs]   = useState(false);                    // 자막 굽기 모드
  const [subStyle,   setSubStyle]   = useState({                          // 자막 스타일
    fontSize: 28,
    bold: true,
    color: 'white' as 'white'|'yellow'|'black',
    position: 'bottom' as 'top'|'middle'|'bottom',
    background: false,
  });
  const [showSaveOptions, setShowSaveOptions] = useState(false);         // 저장 옵션 드롭다운 표시 여부
  const saveOptionsRef = useRef<HTMLDivElement>(null);                   // 저장 옵션 드롭다운 DOM ref (외부 클릭 감지)
// ─── 언어 목록 조회 ────────────────────────────────────────────
  // URL이 YouTube 영상 링크처럼 보이는지 간단히 확인하는 정규식
  const YT_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([0-9A-Za-z_-]{11})/;

  // 디바운스 타이머 ref: URL 입력 중 얰속 조회 방지
  const langDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * fetchLanguages
   *   - POST /languages 로 해당 영상의 자막 언어 목록을 조회
   *   - URL이 유효한 YouTube 반년 YouTube URL일 때만 호출 (onChange 디바운스로)
   */
  const fetchLanguages = async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    setLangLoading(true);
    setLangError('');
    setAvailableLangs([]);
    setSelectedLang('');
    try {
      const res = await axios.post('http://localhost:8000/languages', { url: targetUrl });
      setAvailableLangs(res.data.languages || []);
    } catch (e: any) {
      // 자막 없는 영상이거나 URL이 잘못된 경우 (추출 단계에서 다시 Whisper 제안)
      setLangError(e.response?.data?.detail || '자막 없음');
    } finally {
      setLangLoading(false);
    }
  };

  // ─── 자막 추출 공통 함수 ───────────────────────────────────────
  /**
   * fetchTranscript
   *   - 백엔드 POST /transcribe 엔드포인트에 자막 추출을 요청
   *   - YouTube 자막 API 우선 시도, 실패 시 use_whisper=true로 재요청 가능
   *
   * @param targetUrl  추출할 YouTube 영상의 전체 URL
   * @param useWhisper true이면 Whisper STT를 사용하도록 백엔드에 지시
   */
  const fetchTranscript = async (targetUrl: string, useWhisper = false, lang?: string) => {
    // lang이 명시적으로 전달되면 그것을 사용, 아니면 현재 selectedLang 상태값 사용
    const language = lang !== undefined ? lang : selectedLang;
    // 이전 상태 전부 초기화 (새 검색 시작)
    setLoading(true);
    setError('');
    setTranscript('');
    setSegments([]);
    searchQueryRef.current = '';
    if (searchInputRef.current) searchInputRef.current.value = '';
    setSearchResults([]);
    setLoopConfig(null);  // 새 영상 검색 시 구간반복 플레이어도 닫음

    try {
      // AbortController: 요청이 너무 길어지면 클라이언트 측에서 강제 취소
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000); // 10분 타임아웃

      const response = await axios.post(
        'http://localhost:8000/transcribe',
        { url: targetUrl, use_whisper: useWhisper, language },
        { signal: controller.signal, timeout: 600000 }
      );

      clearTimeout(timeoutId); // 정상 응답 받으면 타임아웃 취소
      const data = response.data;

      // 백엔드가 no_subtitle 상태를 반환한 경우
      // → YouTube API 자막이 없고 use_whisper=false 였을 때
      if (data.status === 'no_subtitle') {
        setPendingUrl(targetUrl);        // 이후 Whisper 재요청을 위해 URL 보관
        setShowWhisperConfirm(true);     // 사용자에게 Whisper 사용 여부 확인 모달 표시
        return;
      }

      // 정상 응답: 자막 데이터 저장
      setTranscript(data.transcript);          // 전체 평문 자막
      const fetchedSegs = data.segments || [];
      setSegments(fetchedSegs);                // 타임스탬프 포함 세그먼트 배열
      originalSegmentsRef.current = fetchedSegs; // 원본 보관
      setVideoId(data.video_id || '');         // 영상 ID (링크/파일명에 사용)
      console.log('✅ 추출 완료!', data.segments?.length, '개의 세그먼트');

    } catch (err: any) {
      // 에러 타입별 사용자 친화적 메시지 분기
      console.error('❌ 추출 실패:', err);
      let errorMessage = '대사를 추출하는 중 오류가 발생했습니다.';

      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        // 요청이 타임아웃으로 취소된 경우
        errorMessage = '⏱️ 처리 시간이 너무 오래 걸립니다. 더 짧은 영상으로 시도해주세요.';
      } else if (err.response?.status === 500) {
        // 백엔드 내부 서버 오류
        errorMessage = `🔧 서버 오류: ${err.response?.data?.detail || '백엔드 처리 중 문제가 발생했습니다.'}`;
      } else if (err.response?.status === 400) {
        // 잘못된 URL 등 클라이언트 측 요청 오류
        errorMessage = `❌ 잘못된 요청: ${err.response?.data?.detail || '올바른 YouTube URL을 입력해주세요.'}`;
      } else if (!err.response) {
        // 백엔드 서버 자체에 연결할 수 없는 경우 (서버 미실행 등)
        errorMessage = '🔌 백엔드 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.';
      }
      setError(errorMessage);
    } finally {
      // 성공/실패 관계없이 로딩 상태 해제
      setLoading(false);
    }
  };

  // ─── 로컬 파일 업로드 핸들러 (SSE 스트리밍 진행률) ──────────────
  const handleLocalFileUpload = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const allowed = ['mp4', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'mkv', 'avi'];
    if (!allowed.includes(ext)) {
      setError(`지원하지 않는 파일 형식입니다: .${ext}`);
      return;
    }

    setLoading(true);
    setError('');
    setUploadProgress('파일 업로드 중...');
    setTranscribeProgress(0);
    setLocalFileName(file.name);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('http://localhost:8000/upload-transcribe-stream', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '업로드 실패' }));
        throw new Error(err.detail || '업로드 실패');
      }

      // SSE 스트림 읽기
      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림을 읽을 수 없습니다');

      const decoder = new TextDecoder();
      let buffer = '';
      let finalData: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 이벤트 파싱: "event: xxx\ndata: {...}\n\n"
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // 마지막 미완성 이벤트는 버퍼에 유지

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;
          const lines = eventBlock.split('\n');
          let eventType = '';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr = line.slice(6);
          }

          if (!eventType || !dataStr) continue;

          try {
            const payload = JSON.parse(dataStr);

            if (eventType === 'progress') {
              setTranscribeProgress(payload.percent || 0);
              setUploadProgress(payload.stage || 'AI 음성인식 전사 중...');
            } else if (eventType === 'result') {
              finalData = payload;
            } else if (eventType === 'error') {
              throw new Error(payload.detail || '전사 실패');
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message.includes('전사 실패')) throw parseErr;
          }
        }
      }

      if (!finalData) throw new Error('전사 결과를 받지 못했습니다');

      const fetchedSegs = finalData.segments || [];
      setSegments(fetchedSegs);
      originalSegmentsRef.current = fetchedSegs;
      setTranscript(finalData.transcript);
      setVideoId(finalData.video_id || '');
      setLocalMediaUrl(`http://localhost:8000${finalData.media_url}`);
      setUploadProgress('');
      setTranscribeProgress(100);
      showToast(`✅ ${file.name} 전사 완료 (${fetchedSegs.length}개 세그먼트)`);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '알 수 없는 오류';
      setError(msg);
      setUploadProgress('');
      setTranscribeProgress(0);
    } finally {
      setLoading(false);
    }
  };

  /** 전사 없이 미디어만 업로드 (수동 자막 작업용) */
  const handleLocalMediaOnly = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const allowed = ['mp4', 'webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'mkv', 'avi'];
    if (!allowed.includes(ext)) {
      setError(`지원하지 않는 파일 형식입니다: .${ext}`);
      return;
    }
    setLoading(true);
    setError('');
    setUploadProgress('파일 업로드 중...');
    setLocalFileName(file.name);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('http://localhost:8000/upload-media', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '업로드 실패' }));
        throw new Error(err.detail || '업로드 실패');
      }
      const data = await res.json();
      setSegments([]);
      setTranscript(' '); // hasResult = true 트리거 (빈 문자열이면 false)
      setVideoId(data.file_id || '');
      setLocalMediaUrl(`http://localhost:8000${data.media_url}`);
      setUploadProgress('');
      showToast(`📁 ${file.name} 업로드 완료 — 수동 자막 모드`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '알 수 없는 오류';
      setError(msg);
      setUploadProgress('');
    } finally {
      setLoading(false);
    }
  };


  // ─── 폼 제출 핸들러 ───────────────────────────────────────────
  /** URL 입력 후 "추출하기" 버튼 클릭 또는 Enter 입력 시 호출 */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    // 만약 언어 목록이 아직 세팅 안 될 상태라면 언어 먼저 조회 후 추출
    if (!langLoading && availableLangs.length === 0 && !langError && YT_URL_RE.test(url)) {
      await fetchLanguages(url);
    }
    fetchTranscript(url);
  };

  // ─── 언어 변경 시 자동 재추출 ──────────────────────────────────
  /**
   * 사용자가 드롭다운에서 다른 언어를 선택하면:
   *   - 이미 자막이 추출된 상태라면 선택한 언어로 즉시 재추출
   *   - 자막이 없으면 선택만 하고 다음 ‘추출하기’ 때 반영
   */
  const handleLangChange = (code: string) => {
    setSelectedLang(code);
    if (transcript && url) {
      // 이미 자막이 표시되어 있으면 선택한 언어로 즉시 재추출
      // code를 직접 넘겨 state 업데이트 레이스 컨디션 회피
      fetchTranscript(url, false, code);
    }
  };

  // ─── Whisper 확인 모달 핸들러 ─────────────────────────────────
  /** 사용자가 "계속 진행"을 눌렀을 때: Whisper로 재요청 */
  const handleWhisperConfirm = () => {
    setShowWhisperConfirm(false);
    fetchTranscript(pendingUrl, true); // use_whisper=true로 동일 URL 재요청
  };

  /** 사용자가 "취소"를 눌렀을 때: 모달 닫고 상태 정리 */
  const handleWhisperCancel = () => {
    setShowWhisperConfirm(false);
    setPendingUrl(''); // 임시 저장된 URL 제거
  };

  // ─── 클립보드 복사 ────────────────────────────────────────────
  /** 전체 자막 텍스트를 클립보드에 복사, 2초간 "복사됨" 피드백 표시 */
  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000); // 2초 후 원래 아이콘으로 복원
  };

  // ─── 타임스탬프 포맷 변환 ─────────────────────────────────────
  /**
   * formatTimestamp
   *   - 초(float) → "M:SS" 또는 "H:MM:SS" 문자열로 변환
   *   - 예: 90.5 → "1:30", 3661 → "1:01:01"
   */
  const formatTimestamp = useCallback((seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = seconds % 1; // 소수점 이하 (밀리초 부근)

    let timeStr = "";
    if (hours > 0) {
      timeStr = `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      timeStr = `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // 사용자가 설정한 정밀도에 따라 소수점 추가
    if (timestampPrecision > 0) {
      const precisionPart = ms.toFixed(timestampPrecision).substring(1); // ".000" 등
      timeStr += precisionPart;
    }

    return timeStr;
  }, [timestampPrecision]);

  // ─── 자막 내 키워드 검색 ──────────────────────────────────────
  /**
   * handleSearch
   *   - searchQuery를 소문자 변환 후 segments 배열 전체를 순회
   *   - text에 해당 문자열이 포함된 세그먼트를 SearchResult로 수집
   *   - 결과가 없으면 searchResults를 빈 배열로 초기화 (UI에서 "없음" 메시지 표시)
   */
  const handleSearch = (overrideQuery?: string | any) => {
    const q = typeof overrideQuery === 'string' ? overrideQuery : (searchInputRef.current?.value ?? '');
    searchQueryRef.current = q;
    if (!q || !q.trim() || segments.length === 0) {
      setSearchResults([]);
      return;
    }

    const query = q.toLowerCase();
    const results: SearchResult[] = [];
    const addedIndices = new Set<number>();
    const range = searchRange;

    if (fuzzySearch) {
      // ── 유사 포함 검색 ──
      // Step 1: 윈도우 생성 (모든 세그먼트 기준 — 정확 매칭용)
      const windows: { combined: string; decomposed: string; startIdx: number; endIdx: number; centerIdx: number }[] = [];
      for (let i = 0; i < segments.length; i++) {
        const start = Math.max(0, i - Math.floor(range / 2));
        const end = Math.min(segments.length - 1, start + range - 1);
        const combined = segments.slice(start, end + 1).map(s => s.text).join(' ');
        windows.push({ combined, decomposed: decomposeKorean(combined), startIdx: start, endIdx: end, centerIdx: i });
      }

      // Step 2: 정확 매칭 우선 — 원본 + 자모 분해 둘 다 시도
      type ExactHit = { w: typeof windows[0]; hitPos: number; hitLen: number; useDecomposed: boolean };
      const exactHits: ExactHit[] = [];
      const queryDecomposed = decomposeKorean(q);
      for (const w of windows) {
        let hitPos = w.combined.toLowerCase().indexOf(query);
        if (hitPos !== -1) {
          exactHits.push({ w, hitPos, hitLen: query.length, useDecomposed: false });
        } else {
          hitPos = w.decomposed.toLowerCase().indexOf(queryDecomposed);
          if (hitPos !== -1) exactHits.push({ w, hitPos, hitLen: queryDecomposed.length, useDecomposed: true });
        }
      }
      exactHits.sort((a, b) => {
        const aCenter = (a.useDecomposed ? a.w.decomposed : a.w.combined).length / 2;
        const bCenter = (b.useDecomposed ? b.w.decomposed : b.w.combined).length / 2;
        return Math.abs(a.hitPos - aCenter) - Math.abs(b.hitPos - bCenter);
      });
      for (const { w, hitPos, hitLen, useDecomposed } of exactHits) {
        // 히트 위치를 세그먼트 인덱스로 역추적
        let actualStart = w.startIdx, actualEnd = w.startIdx;
        let charOff = 0;
        let startFound = false;
        const hitEnd = hitPos + hitLen - 1;
        for (let si = w.startIdx; si <= w.endIdx; si++) {
          const txt = useDecomposed ? decomposeKorean(segments[si].text) : segments[si].text;
          const segEnd = charOff + txt.length - 1;
          if (!startFound && hitPos <= segEnd) { actualStart = si; startFound = true; }
          if (startFound) { actualEnd = si; if (hitEnd <= segEnd) break; }
          charOff += txt.length + 1; // +1 공백
        }
        // 범위 겹침 체크: 실제 매칭 범위 내 세그먼트가 이미 등록되었으면 건너뜀
        let overlap = false;
        for (let si = actualStart; si <= actualEnd; si++) { if (addedIndices.has(si)) { overlap = true; break; } }
        if (overlap) continue;
        for (let si = actualStart; si <= actualEnd; si++) addedIndices.add(si);
        results.push({
          segment: segments[actualStart],
          matchIndex: actualStart,
          loopStartIdx: actualStart,
          loopEndIdx: actualEnd,
          score: 0,
        });
      }

      // Step 2.5: 단어 포함 매칭 — 쿼리의 모든 단어가 윈도우 안에 존재
      if (results.length === 0) {
        const words = q.split(/\s+/).filter(w => w.length > 0);
        if (words.length >= 2) {
          const wordsDecomposed = words.map(w => decomposeKorean(w).toLowerCase());
          type WordHit = { w: typeof windows[0]; matchCount: number };
          const wordHits: WordHit[] = [];

          for (const w of windows) {
            if (addedIndices.has(w.centerIdx)) continue;
            const combinedLower = w.combined.toLowerCase();
            const decomposedLower = w.decomposed.toLowerCase();
            let matchCount = 0;
            for (let wi = 0; wi < words.length; wi++) {
              if (combinedLower.includes(words[wi].toLowerCase()) ||
                  decomposedLower.includes(wordsDecomposed[wi])) {
                matchCount++;
              }
            }
            if (matchCount === words.length) {
              wordHits.push({ w, matchCount });
            }
          }

          // 모든 단어 포함된 윈도우 → 실제 단어가 있는 세그먼트 범위로 좁힘
          for (const { w } of wordHits) {
            // 각 세그먼트별로 단어 포함 여부 확인하여 실제 범위 계산
            let actualStart = w.endIdx, actualEnd = w.startIdx;
            for (let si = w.startIdx; si <= w.endIdx; si++) {
              const segLower = segments[si].text.toLowerCase();
              const segDecomp = decomposeKorean(segments[si].text).toLowerCase();
              for (let wi = 0; wi < words.length; wi++) {
                if (segLower.includes(words[wi].toLowerCase()) || segDecomp.includes(wordsDecomposed[wi])) {
                  actualStart = Math.min(actualStart, si);
                  actualEnd = Math.max(actualEnd, si);
                }
              }
            }
            let overlap = false;
            for (let si = actualStart; si <= actualEnd; si++) { if (addedIndices.has(si)) { overlap = true; break; } }
            if (overlap) continue;
            for (let si = actualStart; si <= actualEnd; si++) addedIndices.add(si);
            results.push({
              segment: segments[actualStart],
              matchIndex: actualStart,
              loopStartIdx: actualStart,
              loopEndIdx: actualEnd,
              score: 0.01,
            });
          }
        }
      }

      // Step 3: 정확/단어 매칭 없으면 Fuse fallback (자모 분해 기반)
      if (results.length === 0) {
        const fuse = new Fuse(windows, {
          keys: ['decomposed'],
          threshold: fuzzyThreshold,
          distance: 200,
          includeScore: true,
          minMatchCharLength: Math.max(2, Math.floor(queryDecomposed.length * 0.5)),
          ignoreLocation: true,
        });

        const fuseResults = fuse.search(queryDecomposed);

        for (const fr of fuseResults) {
          if ((fr.score ?? 1) > fuzzyThreshold + 0.15) continue;
          const w = fr.item;
          let overlap = false;
          for (let si = w.startIdx; si <= w.endIdx; si++) { if (addedIndices.has(si)) { overlap = true; break; } }
          if (overlap) continue;
          for (let si = w.startIdx; si <= w.endIdx; si++) addedIndices.add(si);
          results.push({
            segment: segments[w.centerIdx],
            matchIndex: w.centerIdx,
            loopStartIdx: w.startIdx,
            loopEndIdx: w.endIdx,
            score: fr.score ?? 0,
          });
        }
      }
    } else {
      // ── 정확 검색: 기존 로직 ──
      segments.forEach((segment, index) => {
        if (addedIndices.has(index)) return;

        const halfRange = Math.floor(range / 2);
        const wStart = Math.max(0, index - halfRange);
        const wEnd = Math.min(segments.length - 1, index + halfRange);
        const parts: { text: string; segIdx: number }[] = [];
        for (let si = wStart; si <= wEnd; si++) {
          if (segments[si].text.length > 0) parts.push({ text: segments[si].text, segIdx: si });
        }

        const combined = parts.map(p => p.text).join(' ').toLowerCase();
        const hitPos = combined.indexOf(query);
        if (hitPos === -1) return;

        const hitEnd = hitPos + query.length - 1;
        let charOffset = 0;
        let loopStartIdx = index;
        let loopEndIdx = index;
        let startFound = false;

        for (const part of parts) {
          const segEnd = charOffset + part.text.length - 1;
          charOffset += part.text.length + 1;
          const clamped = Math.max(0, Math.min(segments.length - 1, part.segIdx));
          if (!startFound && hitPos <= segEnd) { loopStartIdx = clamped; startFound = true; }
          if (startFound) { loopEndIdx = clamped; if (hitEnd <= segEnd) break; }
        }

        for (let si = loopStartIdx; si <= loopEndIdx; si++) addedIndices.add(si);
        results.push({ segment, matchIndex: index, loopStartIdx, loopEndIdx, score: 0 });
      });
    }

    setSearchResults(results);
  };

  /**
   * openYouTubeAtTime
   *   - 구간반복 모드 OFF: 해당 시간부터 YouTube를 새 탭에서 열기
   *   - 구간반복 모드 ON : loopRange가 있으면 해당 범위 전체, 없으면 단일 세그먼트로 반복 시작
   *
   * @param matchIndex  베이스 세그먼트 인덱스
   * @param startTime   타임스탬프 미포함 모드의 YouTube 열기 시간
   * @param loopRange   슬라이딩 윈듀우로 감지한 실제 히트 범위 (startIdx..endIdx)
   */
  const openYouTubeAtTime = useCallback((
    matchIndex: number,
    startTime:  number,
    loopRange?: { startIdx: number; endIdx: number },
  ) => {
    if (interactionModeRef.current === 'play') {
      if (playbackOptionRef.current === 'loop' || playbackOptionRef.current === 'once') {
        const base     = loopRange?.startIdx ?? matchIndex;
        const endIdx   = loopRange?.endIdx   ?? matchIndex;
        const endOffset = Math.max(0, endIdx - base);
        setLoopConfig({ matchIndex: base, startOffset: 0, endOffset });
      } else {
        const timeInSeconds = Math.floor(startTime);
        window.open(`https://www.youtube.com/watch?v=${videoIdRef.current}&t=${timeInSeconds}s`, '_blank');
      }
    } else {
      segmentRefs.current[matchIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateActiveSegDom(matchIndex);
    }
  }, []);

  // ─── 세그먼트 체크박스 ───────────────────────────────────────────
  /** 체크된 세그먼트 셋에서 연속된 그룹 배열 생성. ex) {1,2,3,7,8} → [[1,2,3],[7,8]] */
  const findConnectedGroups = useCallback((segs: Set<number>): number[][] => {
    const sorted = Array.from(segs).sort((a, b) => a - b);
    const groups: number[][] = [];
    let cur: number[] = [];
    for (const idx of sorted) {
      if (cur.length === 0 || idx === cur[cur.length - 1] + 1) {
        cur.push(idx);
      } else { groups.push(cur); cur = [idx]; }
    }
    if (cur.length > 0) groups.push(cur);
    return groups;
  }, []);

  /** 세그먼트 체크박스 토글: 연속 그룹을 찾아 loopConfig 자동 갱신 */
  const handleSegToggle = useCallback((idx: number) => {
    const next = new Set(checkedSegsRef.current);
    if (next.has(idx)) { next.delete(idx); } else { next.add(idx); }

    const groups = findConnectedGroups(next);
    if (groups.length === 0) { setCheckedSegs(new Set()); syncCheckedDom(new Set()); setLoopConfig(null); return; }

    const focusGroup =
      groups.find(g => g.includes(idx)) ??
      groups.find(g => g[g.length - 1] < idx) ??
      groups[0];

    setCheckedSegs(next);
    syncCheckedDom(next);
    setLoopConfig({
      matchIndex: focusGroup[0],
      startOffset: 0,
      endOffset: focusGroup[focusGroup.length - 1] - focusGroup[0],
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [findConnectedGroups, syncCheckedDom]);

  /** 전체 선택/해제 */
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const all = new Set<number>();
      for (let i = 0; i < segments.length; i++) all.add(i);
      setCheckedSegs(all);
      syncCheckedDom(all);
      if (segments.length > 0) {
        setLoopConfig({ matchIndex: 0, startOffset: 0, endOffset: segments.length - 1 });
      }
    } else {
      setCheckedSegs(new Set());
      syncCheckedDom(new Set());
      setLoopConfig(null);
    }
  };

  /**
   * 드래그 중 DOM 직접 조작으로 'checked' 클래스 즉시 반영
   * → setCheckedSegs를 호출하지 않으므로 React 리렌더 0회
   */
  const applyDragHighlight = useCallback((start: number, end: number) => {
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    segmentRefs.current.forEach((el, i) => {
      el?.classList.toggle('checked', i >= s && i <= e);
    });
  }, []);

  /** 드래그 선택 이벤트 핸들러 */
  const handleDragStart = useCallback((idx: number) => {
    // 전체 재생 중에는 새 구간 추가 차단 (삭제는 허용)
    if (!isDragModeRef.current || isSeekModeRef.current || isEditModeRef.current || isPlayAllRef.current) return;
    dragStartIdxRef.current   = idx;
    dragCurrentIdxRef.current = idx;
    setDragStartIdx(idx);
    applyDragHighlight(idx, idx);
  }, [applyDragHighlight]);

  const handleDragEnter = useCallback((idx: number) => {
    const startIdx = dragStartIdxRef.current;
    if (!isDragModeRef.current || startIdx === null) return;
    dragCurrentIdxRef.current = idx;
    applyDragHighlight(startIdx, idx);
  }, [applyDragHighlight]);

  const handleDragEnd = () => {
    const startIdx   = dragStartIdxRef.current;
    const currentIdx = dragCurrentIdxRef.current;
    if (!isDragModeRef.current || startIdx === null) return;

    dragStartIdxRef.current   = null;
    dragCurrentIdxRef.current = null;
    setDragStartIdx(null);

    const endIdx = currentIdx ?? startIdx;

    // 클릭(드래그 없이 같은 지점에서 mouseUp)
    if (startIdx === endIdx) {
      if (rangeClickRef.current === null) {
        // 첫 번째 클릭: 시작점 설정 + 핀 표시
        rangeClickRef.current = startIdx;
        clearRangePins();
        segmentRefs.current[startIdx]?.classList.add('range-pin-start');
        applyDragHighlight(startIdx, startIdx);
        return;
      } else {
        // 두 번째 클릭: 구간 확정
        const first  = rangeClickRef.current;
        const second = startIdx;
        rangeClickRef.current = null;
        const rangeStart = Math.min(first, second);
        const rangeEnd   = Math.max(first, second);
        clearRangePins();
        applyDragHighlight(rangeStart, rangeEnd);
        finalizeRange(rangeStart, rangeEnd);
        return;
      }
    }

    // 드래그: 기존 동작
    rangeClickRef.current = null;
    clearRangePins();
    const rangeStart = Math.min(startIdx, endIdx);
    const rangeEnd   = Math.max(startIdx, endIdx);
    finalizeRange(rangeStart, rangeEnd);
  };

  /** 핀 표시 제거 */
  const clearRangePins = () => {
    segmentRefs.current.forEach(el => {
      el?.classList.remove('range-pin-start');
    });
  };

  /** 구간 확정 공통 로직 */
  const finalizeRange = (rangeStart: number, rangeEnd: number) => {
    if (isMultiRangeMode) {
      const isDup = multiRanges.some(r => r.startIdx === rangeStart && r.endIdx === rangeEnd);
      if (!isDup) {
        const isFirst = multiRanges.length === 0;
        setMultiRanges(prev => [...prev, { startIdx: rangeStart, endIdx: rangeEnd, repeatCount: 1 }]);
        if (isFirst) {
          setLoopConfig({ matchIndex: rangeStart, startOffset: 0, endOffset: rangeEnd - rangeStart });
          setInteractionMode('play');
          if (playbackOptionRef.current === 'popup') setPlaybackOption('loop');
        }
      }
    } else {
      setLoopConfig({
        matchIndex:  rangeStart,
        startOffset: 0,
        endOffset:   rangeEnd - rangeStart,
      });
      setInteractionMode('play');
      if (playbackOptionRef.current === 'popup') setPlaybackOption('loop');
    }
  };

  // loopConfig/multiRanges 변경 시 checkedSegs 동기화
  useEffect(() => {
    if (isMultiRangeMode && multiRanges.length > 0) {
      const ns = new Set<number>();
      multiRanges.forEach(r => {
        for (let i = r.startIdx; i <= r.endIdx; i++) ns.add(i);
      });
      setCheckedSegs(ns);
      syncCheckedDom(ns);
      return;
    }
    if (!loopConfig || segments.length === 0) { setCheckedSegs(new Set()); syncCheckedDom(new Set()); return; }
    const s = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
    const e = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
    const ns = new Set<number>();
    for (let i = s; i <= e; i++) ns.add(i);
    setCheckedSegs(ns);
    syncCheckedDom(ns);
  }, [loopConfig, segments, isMultiRangeMode, multiRanges, syncCheckedDom]);

  // ─── 재생 중 활성 세그먼트 감지 → 자동 스크롤 ─────────────────
  // LoopPlayer의 YT.Player 인스턴스에 직접 접근하기 어려우므로,
  // loopSegment가 활성화된 동안 200ms 인터벌로 현재 재생 시간을 폴링하여
  // 해당 시간에 속하는 세그먼트를 찾아 activeSegIdx를 업데이트한다.
  const loopPlayerRef = useRef<any>(null); // LoopPlayer가 공유해주는 YT.Player ref

  /** YouTube / 로컬 비디오 통합 탐색+재생 헬퍼 */
  const seekAndPlay = useCallback((time: number) => {
    if (localMediaUrl && localVideoRef.current) {
      localVideoRef.current.currentTime = time;
      localVideoRef.current.play();
    } else {
      const player = loopPlayerRef.current;
      if (player?.seekTo) { player.seekTo(time, true); player.playVideo(); }
    }
  }, [localMediaUrl]);

  /** 현재 재생 시간 가져오기 (YouTube / 로컬 통합) */
  const getCurrentTime = useCallback((): number => {
    if (localMediaUrl && localVideoRef.current) {
      return localVideoRef.current.currentTime;
    }
    const player = loopPlayerRef.current;
    return player?.getCurrentTime?.() ?? 0;
  }, [localMediaUrl]);

  /** In 마커 설정 — 시작점 지정 */
  const setInMark = useCallback(() => {
    const t = parseFloat(getCurrentTime().toFixed(2));
    setMarkIn(t);
    showToast(`▶ In: ${formatTimestamp(t)}`);
  }, [getCurrentTime, showToast, formatTimestamp]);

  /** Out 마커 설정 — 끝점 지정 */
  const setOutMark = useCallback(() => {
    const t = parseFloat(getCurrentTime().toFixed(2));
    setMarkOut(t);
    showToast(`◼ Out: ${formatTimestamp(t)}`);
  }, [getCurrentTime, showToast, formatTimestamp]);

  /** In~Out 구간으로 빈 세그먼트 추가 (정밀 모드) */
  const addManualSegment = useCallback(() => {
    if (markIn == null || markOut == null) {
      showToast('⚠ In/Out 마커를 먼저 설정하세요 (I키, O키)');
      return;
    }
    const start = Math.min(markIn, markOut);
    const end = Math.max(markIn, markOut);
    if (end - start < 0.05) {
      showToast('⚠ 구간이 너무 짧습니다');
      return;
    }
    const newSeg: Segment = { start, duration: end - start, text: '' };
    setSegments(prev => {
      const next = [...prev, newSeg];
      next.sort((a, b) => a.start - b.start);
      return next;
    });
    setSegmentsVersion(v => v + 1);
    setMarkIn(null);
    setMarkOut(null);
    showToast(`✅ 세그먼트 추가: ${formatTimestamp(start)} ~ ${formatTimestamp(end)}`);
  }, [markIn, markOut, showToast, formatTimestamp]);

  /** Cut — 연속 세그먼트 빠른 생성 (시작점 자동 이동) */
  const cutSegment = useCallback(() => {
    const t = parseFloat(getCurrentTime().toFixed(2));
    if (markIn == null) {
      // 첫 컷: 시작점 설정
      setMarkIn(t);
      showToast(`✂ 시작점: ${formatTimestamp(t)}  (다음 C키에서 세그먼트 생성)`);
      return;
    }
    const start = Math.min(markIn, t);
    const end = Math.max(markIn, t);
    if (end - start < 0.05) {
      showToast('⚠ 구간이 너무 짧습니다');
      return;
    }
    const newSeg: Segment = { start, duration: end - start, text: '' };
    setSegments(prev => {
      const next = [...prev, newSeg];
      next.sort((a, b) => a.start - b.start);
      return next;
    });
    setSegmentsVersion(v => v + 1);
    setMarkIn(t);  // 현재 시간 → 다음 시작점
    setMarkOut(null);
    showToast(`✅ 세그먼트 추가: ${formatTimestamp(start)} ~ ${formatTimestamp(end)}`);
  }, [markIn, getCurrentTime, showToast, formatTimestamp]);

  // ─── WaveSurfer 파형 초기화 & 비디오 동기화 ─────────────────────
  useEffect(() => {
    if (!localMediaUrl || !waveformContainerRef.current) return;

    // 기존 인스턴스 정리
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }

    const ws = WaveSurfer.create({
      container: waveformContainerRef.current,
      waveColor: 'rgba(99, 102, 241, 0.35)',
      progressColor: 'rgba(99, 102, 241, 0.8)',
      cursorColor: '#6366f1',
      cursorWidth: 2,
      height: waveformHeight,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      hideScrollbar: false,
      autoScroll: true,
      autoCenter: false,
      minPxPerSec: 0,
      // audio는 재생하지 않음 — 비디오에서 소리 출력
      media: localVideoRef.current || undefined,
    });

    // Regions 플러그인 등록 (세그먼트 마커용)
    const regionsPlugin = ws.registerPlugin(RegionsPlugin.create());
    wsRegionsRef.current = regionsPlugin;

    // Timeline 플러그인 등록 (하단 시간 눈금자 — 초기 줌 레벨 기준)
    const initPxPerSec = ws.options.minPxPerSec || 0;
    recreateTimeline(ws, initPxPerSec);

    // Minimap은 별도 useEffect에서 관리 (minimapHeight 변경 시 재생성)

    // 마커 드래그 완료 → 세그먼트 시간 업데이트 (제한 규칙 적용)
    const MIN_GAP = 0.05; // 최소 간격 (초)
    regionsPlugin.on('region-updated', (region: any) => {
      const match = region.id?.match(/^seg-(\d+)$/);
      if (!match) return;
      const idx = parseInt(match[1]);
      setSegments(prev => {
        const next = [...prev];
        if (!next[idx]) return prev;

        const seg = next[idx];
        const segEnd = seg.start + seg.duration;
        let newStart = parseFloat(region.start.toFixed(2));

        // 규칙 1: 이전 세그먼트의 start + MIN_GAP 이하로 이동 금지
        if (idx > 0) {
          const prevStart = next[idx - 1].start;
          newStart = Math.max(newStart, prevStart + MIN_GAP);
        } else {
          newStart = Math.max(newStart, 0); // 0초 미만 금지
        }

        // 규칙 2: 자기 세그먼트의 end - MIN_GAP 이상으로 이동 금지
        newStart = Math.min(newStart, segEnd - MIN_GAP);

        // 규칙 3: 자기 세그먼트 duration 업데이트
        next[idx] = { ...next[idx], start: newStart, duration: segEnd - newStart };

        // 규칙 4: 인접한 이전 세그먼트의 끝(duration)을 자동 조정
        if (idx > 0) {
          const prevSeg = next[idx - 1];
          const prevEnd = prevSeg.start + prevSeg.duration;
          // 이전 세그먼트의 끝이 현재 마커를 넘으면 잘라냄
          if (prevEnd > newStart) {
            next[idx - 1] = { ...prevSeg, duration: Math.max(MIN_GAP, newStart - prevSeg.start) };
          }
        }

        return next;
      });
    });

    // 마커 더블클릭 → 세그먼트 병합 (이전 세그먼트에 흡수)
    regionsPlugin.on('region-double-clicked', (region: any) => {
      const match = region.id?.match(/^seg-(\d+)$/);
      if (!match) return;
      const idx = parseInt(match[1]);
      if (idx === 0) return; // 첫 번째 세그먼트는 삭제 불가

      setSegments(prev => {
        const next = [...prev];
        if (!next[idx] || !next[idx - 1]) return prev;
        const prevSeg = next[idx - 1];
        const curSeg = next[idx];
        const mergedEnd = curSeg.start + curSeg.duration;
        // 이전 세그먼트가 현재 세그먼트의 끝까지 확장
        const mergedDuration = mergedEnd - prevSeg.start;
        // 텍스트 결합
        const mergedText = [prevSeg.text, curSeg.text].filter(Boolean).join(' ');
        next[idx - 1] = { ...prevSeg, duration: mergedDuration, text: mergedText };
        next.splice(idx, 1); // 현재 세그먼트 삭제
        return next;
      });
    });

    setWaveformReady(false);
    ws.load(localMediaUrl);
    wavesurferRef.current = ws;

    ws.on('ready', () => {
      setWaveformReady(true);
      // wavesurfer 내부 스크롤 wrapper에 스크롤바 강제 표시
      try {
        const scrollEl = (ws as any).renderer?.wrapper || ws.getWrapper?.() || waveformContainerRef.current?.firstElementChild;
        if (scrollEl) {
          scrollEl.style.overflowX = 'auto';
          scrollEl.style.overflowY = 'visible';
          scrollEl.style.scrollbarWidth = 'thin';
          scrollEl.style.scrollbarColor = 'rgba(99,102,241,0.5) transparent';
        }
        // 모든 자식 div에도 강제 적용
        waveformContainerRef.current?.querySelectorAll('div').forEach((el: HTMLElement) => {
          if (el.scrollWidth > el.clientWidth || el.style.overflow?.includes('auto') || el.style.overflow?.includes('scroll')) {
            el.style.scrollbarWidth = 'thin';
            el.style.scrollbarColor = 'rgba(99,102,241,0.5) transparent';
          }
        });
      } catch { /* ignore */ }
    });

    // AbortError 억제 (wavesurfer 내부 fetch abort — 정상 동작)
    const suppressAbort = (e: PromiseRejectionEvent) => {
      if (e.reason?.name === 'AbortError') e.preventDefault();
    };
    window.addEventListener('unhandledrejection', suppressAbort);

    // 파형 위에서 휠로 가로 확대/축소 — 마우스 위치 기준
    const container = waveformContainerRef.current;
    const handleWheel = (e: WheelEvent) => {
      const ws2 = wavesurferRef.current;
      if (!ws2 || !container) return;
      e.preventDefault();
      const wrapper = container.querySelector('div[data-testid="waveform"]') as HTMLElement
        || container.firstElementChild as HTMLElement;
      if (!wrapper) return;
      const scrollLeft = wrapper.scrollLeft || 0;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const duration = ws2.getDuration();
      const currentZoom = ws2.options.minPxPerSec || (rect.width / duration);
      const timeAtCursor = (scrollLeft + mouseX) / currentZoom;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const newZoom = Math.max(0, Math.min(800, currentZoom * factor));
      ws2.zoom(newZoom);
      // 줌 레벨에 맞게 타임라인 간격 재생성
      recreateTimeline(ws2, newZoom);
      requestAnimationFrame(() => {
        // 줌 후 스크롤 위치 보정
        const newScrollLeft = timeAtCursor * newZoom - mouseX;
        if (wrapper.scrollTo) wrapper.scrollTo({ left: Math.max(0, newScrollLeft) });
        // 줌 후 스크롤바 강제 표시
        wrapper.style.overflowX = 'auto';
        wrapper.style.overflowY = 'visible';
        wrapper.style.scrollbarWidth = 'thin';
        wrapper.style.scrollbarColor = 'rgba(99,102,241,0.5) transparent';
      });
    };
    container?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      window.removeEventListener('unhandledrejection', suppressAbort);
      container?.removeEventListener('wheel', handleWheel);
      wsRegionsRef.current = null;
      setWaveformReady(false);
      ws.destroy();
      wavesurferRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localMediaUrl]);

  // ─── 미니맵 높이 변경 시 플러그인 재생성 ────────────────────
  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !waveformReady || !waveformContainerRef.current) return;
    // 기존 미니맵 제거
    if (wsMinimapRef.current) {
      try { wsMinimapRef.current.destroy(); } catch { /* ignore */ }
      wsMinimapRef.current = null;
    }
    // 새 미니맵 생성
    const mm = ws.registerPlugin(MinimapPlugin.create({
      height: minimapHeight,
      waveColor: 'rgba(99, 102, 241, 0.25)',
      progressColor: 'rgba(99, 102, 241, 0.5)',
      overlayColor: 'rgba(0, 0, 0, 0.55)',
      container: waveformContainerRef.current,
      insertPosition: 'afterend' as InsertPosition,
    }));
    wsMinimapRef.current = mm;

    // 미니맵 클릭 시 해당 지점을 뷰포트 중앙에 배치
    mm.on('click', (relativeX: number) => {
      const duration = ws.getDuration() || 1;
      const clickedTime = relativeX * duration;
      ws.seekTo(relativeX);

      const centerScroll = () => {
        const wrapper = (ws as any).renderer?.wrapper || ws.getWrapper?.();
        if (!wrapper) return;
        const containerWidth = waveformContainerRef.current?.clientWidth || wrapper.clientWidth;
        const pxPerSec = ws.options.minPxPerSec || (containerWidth / duration);
        const clickedPx = clickedTime * pxPerSec;
        wrapper.scrollLeft = Math.max(0, clickedPx - containerWidth / 2);
      };
      centerScroll();
      setTimeout(centerScroll, 50);
      setTimeout(centerScroll, 150);
    });

    // ─── 미니맵 오버레이 드래그 → 메인 파형 스크롤 ─────────────
    // 잠시 후 미니맵 DOM이 렌더된 뒤에 오버레이를 찾아 드래그 핸들러 부착
    let dragCleanup: (() => void) | null = null;

    setTimeout(() => {
      const minimapWrap = waveformContainerRef.current?.parentElement?.querySelector('[part="minimap"]') as HTMLElement | null;
      if (!minimapWrap) return;
      const overlay = minimapWrap.querySelector('[part="minimap-overlay"]') as HTMLElement | null;
      if (!overlay) return;

      // overlay 활성화: 이벤트 수신 + 최상위 배치
      overlay.style.pointerEvents = 'auto';
      overlay.style.zIndex = '10';
      overlay.style.cursor = 'grab';

      const EDGE_PX = 8;
      type DragMode = 'none' | 'scroll' | 'resize-left' | 'resize-right';
      let mode: DragMode = 'none';
      let startX = 0;
      let startScrollLeft = 0;
      let startPxPerSec = 0;
      let scrollRatio = 1;
      let rightEdgeTime = 0;
      let leftEdgeTime = 0;
      let targetZoom = 0;

      // 스크롤 컨테이너 찾기 (wrapper의 부모 = overflow-x 스크롤 요소)
      const getScrollContainer = (): HTMLElement | null => {
        // renderer.wrapper는 .wrapper (내부 요소), 스크롤은 그 부모 .scroll에서 발생
        const wrapper = (ws as any).renderer?.wrapper as HTMLElement | undefined;
        if (wrapper?.parentElement) return wrapper.parentElement;
        // fallback: waveformContainer 내부 첫 자식의 shadowRoot에서 scroll 찾기
        const firstChild = waveformContainerRef.current?.firstElementChild;
        const shadow = firstChild?.shadowRoot;
        if (shadow) {
          return shadow.querySelector('[part="scroll"]') as HTMLElement;
        }
        return waveformContainerRef.current?.firstElementChild as HTMLElement;
      };

      const detectEdge = (clientX: number): DragMode => {
        const rect = overlay!.getBoundingClientRect();
        if (clientX - rect.left < EDGE_PX) return 'resize-left';
        if (rect.right - clientX < EDGE_PX) return 'resize-right';
        return 'scroll';
      };

      // 호버 커서
      overlay.addEventListener('pointermove', (e: PointerEvent) => {
        if (mode !== 'none') return;
        const edge = detectEdge(e.clientX);
        overlay!.style.cursor = edge === 'scroll' ? 'grab' : 'ew-resize';
      });

      // pointerdown → 드래그 시작
      const onDown = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();

        mode = detectEdge(e.clientX);
        startX = e.clientX;
        const mainWrapper = getScrollContainer();
        startScrollLeft = mainWrapper?.scrollLeft ?? 0;

        const duration = ws.getDuration() || 1;
        const containerWidth = waveformContainerRef.current?.clientWidth || 1;
        startPxPerSec = ws.options.minPxPerSec || (containerWidth / duration);
        leftEdgeTime = startScrollLeft / startPxPerSec;
        rightEdgeTime = (startScrollLeft + containerWidth) / startPxPerSec;
        targetZoom = startPxPerSec;

        if (mode === 'scroll') {
          const totalWidth = duration * startPxPerSec;
          scrollRatio = totalWidth / minimapWrap!.clientWidth;
          overlay!.style.cursor = 'grabbing';
        } else {
          overlay!.style.cursor = 'ew-resize';
        }

        // setPointerCapture: 이후 모든 pointermove가 overlay로 전달됨
        overlay!.setPointerCapture(e.pointerId);
        ws.setOptions({ autoScroll: false });
      };

      const onMove = (e: PointerEvent) => {
        if (mode === 'none') return;
        e.preventDefault();
        const dx = e.clientX - startX;
        const duration = ws.getDuration() || 1;
        const containerWidth = waveformContainerRef.current?.clientWidth || 1;
        const minimapWidth = minimapWrap!.clientWidth;
        const mainWrapper = getScrollContainer();

        if (mode === 'scroll' && mainWrapper) {
          mainWrapper.scrollLeft = Math.max(0, startScrollLeft + dx * scrollRatio);
        } else if (mode === 'resize-left' || mode === 'resize-right') {
          const currentOverlayWidth = (containerWidth / (duration * startPxPerSec)) * minimapWidth;
          const newOverlayWidth = Math.max(20,
            mode === 'resize-right'
              ? currentOverlayWidth + dx
              : currentOverlayWidth - dx
          );
          const newVisibleDuration = (newOverlayWidth / minimapWidth) * duration;
          targetZoom = Math.max(1, Math.min(800, containerWidth / newVisibleDuration));
        }
      };

      const onUp = (e: PointerEvent) => {
        if (mode === 'none') return;
        const prevMode = mode;
        mode = 'none';
        overlay!.style.cursor = 'grab';
        overlay!.releasePointerCapture(e.pointerId);

        // 리사이즈: 드랍 시점에만 줌 적용
        if ((prevMode === 'resize-left' || prevMode === 'resize-right') && targetZoom > 0) {
          const containerWidth = waveformContainerRef.current?.clientWidth || 1;
          ws.zoom(targetZoom);
          recreateTimeline(ws, targetZoom);
          const mainWrapper = getScrollContainer();
          if (mainWrapper) {
            // resize-left: 오른쪽 끝 고정, resize-right: 왼쪽 끝 고정
            const newScroll = prevMode === 'resize-left'
              ? Math.max(0, rightEdgeTime * targetZoom - containerWidth)
              : Math.max(0, leftEdgeTime * targetZoom);
            mainWrapper.scrollLeft = newScroll;
            requestAnimationFrame(() => { mainWrapper.scrollLeft = newScroll; });
          }
        }

        ws.setOptions({ autoScroll: true });
      };

      overlay.addEventListener('pointerdown', onDown);
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
      overlay.addEventListener('pointercancel', onUp);

      // 오버레이 클릭 시 내부 WaveSurfer seek 차단 (click은 pointerdown 후 발생)
      const onCapClick = (e: MouseEvent) => {
        const rect = overlay!.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      };
      minimapWrap.addEventListener('click', onCapClick, true);

      dragCleanup = () => {
        overlay!.removeEventListener('pointerdown', onDown);
        overlay!.removeEventListener('pointermove', onMove);
        overlay!.removeEventListener('pointerup', onUp);
        overlay!.removeEventListener('pointercancel', onUp);
        minimapWrap!.removeEventListener('click', onCapClick, true);
      };
    }, 500);

    return () => { dragCleanup?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimapHeight, waveformReady]);

  // ─── 세그먼트 ↔ 파형 마커 동기화 (전체 균등 샘플링, 줌 비례 밀도) ──
  // WaveSurfer Region은 시간 기반 배치 → 스크롤/줌에 관계없이 올바른 위치에 표시.
  // 줌 배율이 높을수록 마커 수를 비례적으로 늘려 더 상세하게 표시.
  const BASE_MARKERS = 50; // 기본 줌(전체 보기)일 때 마커 수
  const [markerZoom, setMarkerZoom] = useState(1); // 줌 배율 (1 = 전체 보기)

  // 줌 이벤트 → markerZoom 갱신
  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws || !waveformReady) return;

    const onZoom = () => {
      const duration = ws.getDuration() || 1;
      const container = waveformContainerRef.current;
      const containerWidth = container?.clientWidth || 1;
      const pxPerSec = ws.options.minPxPerSec || (containerWidth / duration);
      const baseZoom = containerWidth / duration; // 전체 보기 시 pxPerSec
      const factor = Math.max(1, pxPerSec / baseZoom);
      setMarkerZoom(factor);
    };

    ws.on('zoom', onZoom);
    return () => { ws.un('zoom', onZoom); };
  }, [waveformReady]);

  // 마커 생성 (segments·markerZoom이 바뀔 때마다)
  useEffect(() => {
    const rp = wsRegionsRef.current;
    if (!rp || !localMediaUrl || !waveformReady) return;

    // 기존 마커 전부 제거
    rp.getRegions().forEach((r: any) => {
      if (r.id?.startsWith('seg-')) r.remove();
    });
    if (segments.length === 0) return;

    // 줌 배율에 비례한 마커 수 (최소 BASE_MARKERS, 최대 segments.length)
    const markerCount = Math.min(segments.length, Math.round(BASE_MARKERS * markerZoom));

    // 전체 세그먼트에서 균등 샘플링
    const indices: number[] = [];
    if (segments.length <= markerCount) {
      for (let i = 0; i < segments.length; i++) indices.push(i);
    } else {
      const step = (segments.length - 1) / (markerCount - 1);
      const picked = new Set<number>();
      for (let k = 0; k < markerCount; k++) picked.add(Math.round(k * step));
      picked.forEach(i => indices.push(i));
      indices.sort((a, b) => a - b);
    }

    // 샘플링된 마커만 Region으로 추가
    indices.forEach(idx => {
      const seg = segments[idx];
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;top:2px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;cursor:grab;z-index:10;pointer-events:auto;';
      const timeLabel = document.createElement('span');
      const m = Math.floor(seg.start / 60);
      const s = seg.start % 60;
      timeLabel.textContent = m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
      timeLabel.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.7);white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.9);line-height:1;margin-bottom:1px;';
      const arrow = document.createElement('span');
      arrow.textContent = '\u25BC';
      arrow.style.cssText = 'color:#ef4444;font-size:14px;line-height:1;text-shadow:0 0 4px rgba(0,0,0,0.8);';
      wrapper.appendChild(timeLabel);
      wrapper.appendChild(arrow);
      const region = rp.addRegion({
        id: `seg-${idx}`,
        start: seg.start,
        content: wrapper,
        color: 'rgba(0,0,0,0)',
        drag: true,
        resize: false,
      });
      const el = region.element as HTMLElement | undefined;
      if (el) {
        el.classList.add('wf-seg-marker');
        el.style.setProperty('border-left', 'none', 'important');
        el.style.setProperty('background', 'repeating-linear-gradient(to bottom, #ef4444 0px, #ef4444 4px, transparent 4px, transparent 8px)', 'important');
        el.style.setProperty('width', '2px', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('z-index', '3', 'important');
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, localMediaUrl, waveformReady, markerZoom]);

  useEffect(() => {
    // 트래킹 모드 꺼져 있거나 세그먼트 없으면 종료
    if (!isTrackingMode || segments.length === 0) {
      updateActiveSegDom(-1);
      return;
    }
    if (dragStartIdx !== null) return;

    const timer = setInterval(() => {
      // 로컬 비디오: 일시정지 중이면 건너뜀
      if (localMediaUrl && localVideoRef.current) {
        if (localVideoRef.current.paused) return;
      } else {
        const player = loopPlayerRef.current;
        if (!player?.getCurrentTime) return;
        const state = player.getPlayerState?.();
        if (state !== 1) return;
      }

      const t = getCurrentTime() + trackingOffset;

      let found = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].start <= t) { found = i; break; }
      }
      if (found !== -1) {
        // 구간 반복 중이면 선택된 구간 밖의 세그먼트에는 active 표시하지 않음
        // (전체 재생 모드에서는 구간 전환 시 loopConfig가 비동기 갱신되므로 체크 건너뜀)
        if (loopConfig && !isPlayAllRef.current) {
          const rangeStart = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
          const rangeEnd   = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
          if (found < rangeStart || found > rangeEnd) {
            updateActiveSegDom(-1);
            return;
          }
        }
        // updateActiveSegDom이 내부에서 prev !== newIdx일 때만 처리하므로
        // 여기서는 found가 바뀌었을 때만 스크롤 (매 tick 호출 방지)
        const segChanged = activeSegIdxRef.current !== found;
        updateActiveSegDom(found);
        if (isAutoScrollRef.current && !userScrollingRef.current && segChanged) {
          // 가상화 환경: 화면 밖 세그먼트는 DOM에 없어 segEl이 null → 확실히 화면 밖
          let inView = false;
          const segEl = segmentRefs.current[found];
          const scrollEl = transcriptScrollRef.current;
          if (segEl && scrollEl) {
            const segRect = segEl.getBoundingClientRect();
            const scrollRect = scrollEl.getBoundingClientRect();
            inView = segRect.top >= scrollRect.top && segRect.bottom <= scrollRect.bottom;
          }
          if (!inView) {
            programmaticScrollRef.current = true;
            const scrollIdx = displaySegMap ? displaySegMap.indexOf(found) : found;
            if (scrollIdx >= 0) virtualizer.scrollToIndex(scrollIdx, { align: 'center', behavior: 'auto' });
            setTimeout(() => { programmaticScrollRef.current = false; }, 100);
          }
        }
      }
    }, 50);
    return () => clearInterval(timer);
  }, [segments, isTrackingMode, dragStartIdx, trackingOffset, updateActiveSegDom, loopConfig, getCurrentTime, localMediaUrl]);

  // 휠/스크롤바 모두 통합 감지: scroll 이벤트는 위치 변경 후 발생 → 정확한 가시성 체크
  useEffect(() => {
    const scrollEl = transcriptScrollRef.current;
    if (!scrollEl) return;
    const onScroll = () => {
      if (!isAutoScrollRef.current) return;
      if (programmaticScrollRef.current) return;
      // 사용자 스크롤 감지 → scrollIntoView 억제 (wheelTimeoutRef 공유)
      userScrollingRef.current = true;
      programmaticScrollRef.current = false;
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
      wheelTimeoutRef.current = setTimeout(() => { userScrollingRef.current = false; }, 500);
      // 즉시 가시성 체크
      const idx = activeSegIdxRef.current;
      if (idx < 0) return;
      const segEl = segmentRefs.current[idx];
      if (!segEl) return;
      const segRect = segEl.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      if (segRect.bottom < scrollRect.top || segRect.top > scrollRect.bottom) {
        isAutoScrollRef.current = false;
        setIsAutoScroll(false);
      }
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [segments.length]);

  // ─── 다중 구간 순차 재생 ──────────────────────────────────────
  // gapTimerRef / isInGapRef: 구간 간격 대기 상태 관리
  const isInGapRef  = useRef(false);
  const activeMultiRangeIdxRef = useRef(0);
  const rangePlayCountRef = useRef(0); // 현재 구간 재생 횟수 카운터
  const isPlayAllRef = useRef(false);  // true=전체 재생(순차 전환), false=개별 구간만 반복
  const [isPlayAllActive, setIsPlayAllActive] = useState(false); // 전체 재생 시 대본 필터링 트리거

  // 전체 재생 시: 선택 구간 세그먼트만 표시 (Set으로 중복 제거)
  const displaySegMap = useMemo(() => {
    if (!isPlayAllActive || multiRanges.length === 0) return null;
    const indexSet = new Set<number>();
    for (const r of multiRanges) {
      for (let j = r.startIdx; j <= r.endIdx; j++) indexSet.add(j);
    }
    return [...indexSet].sort((a, b) => a - b);
  }, [isPlayAllActive, multiRanges]);
  // 구간별 고유 색상 팔레트 (연대기 라인용)
  const RANGE_COLORS = ['#6366f1','#f59e0b','#ec4899','#14b8a6','#8b5cf6','#ef4444','#06b6d4','#84cc16','#f97316','#a855f7'];

  // segRangeMap: 세그먼트 인덱스 → 소속 구간의 원본 인덱스 목록 (multiRanges 배열 기준)
  const segRangeMap = useMemo(() => {
    if (!isMultiRangeMode || multiRanges.length === 0) return null;
    const rangeMap = new Map<number, number[]>(); // segIdx → [multiRanges 원본 인덱스들]
    multiRanges.forEach((r, ri) => {
      for (let j = r.startIdx; j <= r.endIdx; j++) {
        const existing = rangeMap.get(j);
        if (existing) existing.push(ri);
        else rangeMap.set(j, [ri]);
      }
    });
    return rangeMap;
  }, [isMultiRangeMode, multiRanges]);
  useEffect(() => { activeMultiRangeIdxRef.current = activeMultiRangeIdx; }, [activeMultiRangeIdx]);

  useEffect(() => {
    // 다중 구간 모드 + 구간 2개 이상 + loopMode일 때 interval 설정
    if (!isMultiRangeMode || multiRanges.length < 2 || !loopMode) return;
    if (dragStartIdx !== null) return;

    let cancelled = false; // 이 effect 인스턴스가 cleanup됐는지 여부

    const timer = setInterval(() => {
      // 전체 재생 모드가 아니면 구간 전환 로직 건너뜀 (개별 재생은 LoopPlayer가 자체 반복)
      if (!isPlayAllRef.current) return;
      if (isInGapRef.current) return;
      const player = loopPlayerRef.current;
      if (!player?.getCurrentTime) return;

      const state     = player.getPlayerState?.();
      const t         = player.getCurrentTime();
      const curIdx    = activeMultiRangeIdxRef.current; // ref로 즉시 읽기
      const cur       = multiRanges[curIdx];
      if (!cur || !segments[cur.endIdx]) return;

      // endTime 계산: 단일 구간(loopSegment)과 동일하게 다음 세그먼트 시작 시간을 사용
      // (start + duration 방식은 다음 세그먼트 영역까지 침범할 수 있음)
      const nextSeg    = segments[cur.endIdx + 1];
      const endTime    = nextSeg
        ? nextSeg.start
        : segments[cur.endIdx].start + segments[cur.endIdx].duration;
      // 재생이 구간 끝에 도달했거나 영상이 자연 종료된 경우
      const rangeEnded = (state === 1 && t >= endTime - 0.05) || state === 0;
      if (!rangeEnded) return;

      isInGapRef.current = true;
      if (state !== 0) player.pauseVideo();

      // 현재 구간 반복 횟수 체크
      rangePlayCountRef.current += 1;
      const targetRepeat = cur.repeatCount ?? 1;

      if (rangePlayCountRef.current < targetRepeat) {
        // 아직 반복 남음: 같은 구간 다시 재생
        const curStart = segments[cur.startIdx]?.start ?? 0;
        setTimeout(() => {
          if (cancelled) return;
          player.seekTo(curStart, true);
          player.playVideo();
          isInGapRef.current = false;
        }, rangeGap * 1000);
        return;
      }

      // 반복 완료: 다음 구간으로
      rangePlayCountRef.current = 0;

      // repeatCount가 0인 구간 스킵
      let nextIdx = (curIdx + 1) % multiRanges.length;
      let safeCount = 0;
      while ((multiRanges[nextIdx]?.repeatCount ?? 1) === 0 && safeCount < multiRanges.length) {
        nextIdx = (nextIdx + 1) % multiRanges.length;
        safeCount++;
      }
      if (safeCount >= multiRanges.length) { isInGapRef.current = false; return; } // 모두 0이면 정지

      const next      = multiRanges[nextIdx];
      const nextStart = segments[next.startIdx]?.start ?? 0;

      // 즉시 ref 업데이트 → 다음 tick에 중복 감지 방지
      activeMultiRangeIdxRef.current = nextIdx;
      setActiveMultiRangeIdx(nextIdx); // UI용 state (비동기, deps에서 제거)

      setTimeout(() => {
        if (cancelled) return; // 이 effect가 이미 cleanup됐으면 중단
        setLoopConfig({
          matchIndex:  next.startIdx,
          startOffset: 0,
          endOffset:   next.endIdx - next.startIdx,
        });
        player.seekTo(nextStart, true);
        player.playVideo();
        isInGapRef.current = false;
      }, rangeGap * 1000);
    }, 150);

    return () => {
      cancelled = true; // setTimeout 콜백에서 이 effect 인스턴스가 만료됐음을 인식
      clearInterval(timer);
      // gapTimerRef는 cancelled 플래그로 처리 → clearTimeout 불필요
      isInGapRef.current = false;
    };
  // activeMultiRangeIdx를 deps에서 제거: ref로 접근하므로 재실행 불필요
  // (포함 시 setActiveMultiRangeIdx 호출 → 재실행 → gap 타이머 클리어되는 버그)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiRangeMode, multiRanges, loopMode, segments, rangeGap, dragStartIdx]);

  // ─── 글로벌 단축키 (스페이스바 + I/O 마커) ──────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // input, textarea, select에 포커스 시에는 텍스트 입력 우선
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Ctrl/Cmd/Alt 조합은 무시 (Ctrl+C 등 시스템 단축키 보호)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (localMediaUrl && localVideoRef.current) {
          // 로컬 비디오 재생/일시정지
          localVideoRef.current.paused ? localVideoRef.current.play() : localVideoRef.current.pause();
        } else {
          const player = loopPlayerRef.current;
          if (!player?.getPlayerState) return;
          const state = player.getPlayerState();
          if (state === 1) { player.pauseVideo(); } else { player.playVideo(); }
        }
      } else if (e.key === 'i' || e.key === 'I') {
        setInMark();
      } else if (e.key === 'o' || e.key === 'O') {
        setOutMark();
      } else if (e.key === 'p' || e.key === 'P') {
        addManualSegment();
      } else if (e.key === 'c' || e.key === 'C') {
        cutSegment();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 5; // Shift 누르면 1초, 기본 5초
        const delta = e.key === 'ArrowLeft' ? -step : step;
        if (localMediaUrl && localVideoRef.current) {
          localVideoRef.current.currentTime = Math.max(0, localVideoRef.current.currentTime + delta);
        } else {
          const player = loopPlayerRef.current;
          if (player?.getCurrentTime && player?.seekTo) {
            const t = Math.max(0, player.getCurrentTime() + delta);
            player.seekTo(t, true);
          }
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [localMediaUrl, setInMark, setOutMark, addManualSegment, cutSegment]);

  // ─── 탭 전환 시 URL 입력창 자동 포커스 ───────────────────────
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && !videoId) {
        urlInputRef.current?.focus();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [videoId]);

  // ─── 저장 옵션 드롭다운 외부 클릭 시 닫기 ────────────────────
  useEffect(() => {
    if (!showSaveOptions) return;
    const handler = (e: MouseEvent) => {
      if (saveOptionsRef.current && !saveOptionsRef.current.contains(e.target as Node)) {
        setShowSaveOptions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSaveOptions]);

  // ─── 편집 설정 드롭다운 외부 클릭 시 닫기 ────────────────────
  const editSettingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showEditSettings) return;
    const handler = (e: MouseEvent) => {
      if (editSettingsRef.current && !editSettingsRef.current.contains(e.target as Node)) {
        setShowEditSettings(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEditSettings]);

  // ─── 검색 설정 드롭다운 외부 클릭 시 닫기 ────────────────────
  const searchOptsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSearchOpts) return;
    const handler = (e: MouseEvent) => {
      if (searchOptsRef.current && !searchOptsRef.current.contains(e.target as Node)) {
        setShowSearchOpts(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSearchOpts]);
  // ─── 검색어 키워드 하이라이트 헬퍼 ───────────────────────────
  // text를 query 기준으로 분리하여 <mark>로 감싼 React 노드 배열로 반환
  const highlightText = useCallback((text: string, query: string): React.ReactNode => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="search-match">{part}</mark>
        : part
    );
  }, []);

  // ─── 가상 스크롤 (Virtual Scroll) ───────────────────────────
  const virtualizer = useVirtualizer({
    count: displaySegMap ? displaySegMap.length : segments.length,
    getScrollElement: () => transcriptScrollRef.current,
    estimateSize: () => 38, // min-height 2.4rem ≈ 38px
    overscan: 10,
  });

  // ─── 편집 모드: 키보드 네비게이션 ─────────────────────────────
  /** 특정 세그먼트의 편집 input으로 포커스 이동 (가상 스크롤 대응) */
  const focusEditInput = useCallback((targetSegIdx: number, cursorPos: number) => {
    const scrollIdx = displaySegMap ? displaySegMap.indexOf(targetSegIdx) : targetSegIdx;
    if (scrollIdx < 0) return;
    virtualizer.scrollToIndex(scrollIdx, { align: 'center', behavior: 'auto' });
    requestAnimationFrame(() => {
      setTimeout(() => {
        const row = document.querySelector(`[data-index="${targetSegIdx}"]`);
        const input = row?.querySelector('.seg-edit-text') as HTMLInputElement | null;
        if (input) {
          input.focus();
          const pos = Math.min(cursorPos, input.value.length);
          input.setSelectionRange(pos, pos);
        }
      }, 60);
    });
  }, [displaySegMap, virtualizer]);

  /** 편집 input 키보드 핸들러: Enter(분리), Delete(병합), ↑↓(이동) */
  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    const input = e.currentTarget;
    const cursorPos = input.selectionStart ?? 0;
    const selEnd = input.selectionEnd ?? cursorPos;
    const textLen = input.value.length;
    const total = segments.length;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (i >= total - 1) return;
      const before = input.value.substring(0, cursorPos);
      const after = input.value.substring(selEnd).trim();
      setSegments(prev => prev.map((s, j) => {
        if (j === i) return { ...s, text: before };
        if (j === i + 1) return { ...s, text: after + (after && s.text.trim() ? ' ' : '') + s.text.trim() };
        return s;
      }));
      setSegmentsVersion(v => v + 1);
      focusEditInput(i + 1, 0);
    } else if (e.key === 'Delete' && cursorPos === textLen && cursorPos === selEnd) {
      e.preventDefault();
      if (i >= total - 1) return;
      const nextText = segments[i + 1].text.trim();
      setSegments(prev => prev.map((s, j) => {
        if (j === i) return { ...s, text: input.value + (nextText ? ' ' + nextText : '') };
        if (j === i + 1) return { ...s, text: '' };
        return s;
      }));
      setSegmentsVersion(v => v + 1);
      focusEditInput(i, cursorPos);
    } else if (e.key === 'Backspace' && cursorPos === 0 && cursorPos === selEnd) {
      e.preventDefault();
      if (i <= 0) return; // 첫 번째 세그먼트
      const prevText = segments[i - 1].text.trim();
      const curText = input.value.trim();
      const newPrevLen = prevText.length; // 이전 텍스트 끝 = 새 커서 위치
      setSegments(prev => prev.map((s, j) => {
        if (j === i - 1) return { ...s, text: prevText + (prevText && curText ? ' ' : '') + curText };
        if (j === i) return { ...s, text: '' };
        return s;
      }));
      setSegmentsVersion(v => v + 1);
      focusEditInput(i - 1, prevText ? newPrevLen + 1 : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      let target = i - 1;
      if (target < 0) target = wrapEditNav ? total - 1 : -1;
      if (target >= 0) focusEditInput(target, cursorPos);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      let target = i + 1;
      if (target >= total) target = wrapEditNav ? 0 : -1;
      if (target >= 0) focusEditInput(target, cursorPos);
    }
  }, [segments, wrapEditNav, focusEditInput]);

  // 히트 인덱스 Set (검색결과 빠른 조회)
  const hitSet = useMemo(() => new Set(searchResults.map(r => r.matchIndex)), [searchResults]);

  // ─── TXT 파일 다운로드 ────────────────────────────────────────
  /**
   * decodeHtmlEntities
   *   YouTube Transcript API가 반환하는 HTML 엔티티를 실제 문자로 변환
   *   예: &amp; → &, &#39; → ', &quot; → ", &lt; → <, &gt; → >
   *   textarea의 innerHTML 할당을 통해 브라우저 내장 파서를 활용
   */
  const decodeHtmlEntities = (text: string): string => {
    const ta = document.createElement('textarea');
    ta.innerHTML = text;
    return ta.value;
  };

  /**
   * downloadTxt
   *   - includeTimestamps가 true이면 "[0:00] 텍스트" 형식으로 세그먼트를 줄바꿈 연결
   *   - false이면 전체 평문(transcript) 저장
   *   - HTML 엔티티 디코딩 후 저장 (YouTube API가 &amp; 등을 그대로 반환)
   *   - Windows CRLF(\r\n) 줄바꿈 → 메모장에서 정상 표시
   *   - UTF-8 BOM(\uFEFF) → Windows에서 한글 인코딩 자동 인식
   */
  const downloadTxt = () => {
    try {
      let content: string;

      if (includeTimestamps && segments.length > 0) {
        // 타임스탬프 포함: 항상 세그먼트마다 줄바꿈 + lineBreakCount 만큼 빈 줄 추가
        const extra = '\r\n'.repeat(lineBreakCount); // 빈 줄 수만큼 추가 줄바꿈
        content = segments
          .map(seg => `[${formatTimestamp(seg.start)}] ${decodeHtmlEntities(seg.text.trim())}`)
          .join('\r\n' + extra);
      } else {
        // 타임스탬프 미포함
        if (segments.length > 0) {
          if (lineBreak) {
            // 줄바꿈 ON: \r\n + lineBreakCount 만큼 빈 줄 삽입
            // lineBreakCount=0 → 줄바꿈만 (빈 줄 없음)
            // lineBreakCount=1 → 1줄 빈 줄 (세그먼트 사이 한 줄 공백)
            // lineBreakCount=2 → 2줄 빈 줄
            const separator = '\r\n' + '\r\n'.repeat(lineBreakCount);
            content = segments
              .map(seg => decodeHtmlEntities(seg.text.trim()))
              .join(separator);
          } else {
            // 줄바꿈 OFF: 공백으로 이어붙이기 (기존 동작)
            content = segments
              .map(seg => decodeHtmlEntities(seg.text.trim()))
              .join(' ');
          }
        } else {
          content = decodeHtmlEntities(transcript);
        }
      }

      // Windows CRLF 정규화
      content = content.replace(/\r?\n/g, '\r\n');

      // BOM: Windows 환경에서 UTF-8 자동 인식을 위해 필요
      const bom = '\uFEFF';
      const blob = new Blob([bom + content], { type: 'text/plain;charset=utf-8' });

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `transcript_${videoId || 'output'}${includeTimestamps ? '_with_timestamps' : ''}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);

    } catch (err) {
      console.error('다운로드 실패:', err);
      alert('파일 저장 중 오류가 발생했습니다. 복사 기능을 이용해 주세요.');
    }
  };


  // ─── SRT 파일 내보내기 (발음 자막용) ────────────────────────────
  const toSrtTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  const downloadSrt = () => {
    if (segments.length === 0) return;
    const lines = segments.map((seg, i) => {
      const text = (translations[i] || '').trim() || decodeHtmlEntities(seg.text.trim());
      const start = toSrtTime(seg.start);
      const end = toSrtTime(seg.start + seg.duration);
      return `${i + 1}\r\n${start} --> ${end}\r\n${text}`;
    });
    const content = '\uFEFF' + lines.join('\r\n\r\n') + '\r\n';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `phonetic_${videoId || 'output'}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  // ─── SRT 파일 업로드 (자막 복원) ────────────────────────────────
  const srtInputRef = useRef<HTMLInputElement>(null);

  /** SRT 타임스탬프 → 초 변환 (e.g. "00:01:23,456" → 83.456) */
  const parseSrtTime = (t: string): number => {
    const m = t.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  };

  /** SRT 텍스트 → Segment[] 파싱 */
  const parseSrt = (text: string): Segment[] => {
    const blocks = text.trim().replace(/\r\n/g, '\n').split(/\n\n+/);
    const segs: Segment[] = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;
      const timeLineIdx = lines.findIndex(l => l.includes('-->'));
      if (timeLineIdx < 0) continue;
      const [startStr, endStr] = lines[timeLineIdx].split('-->').map(s => s.trim());
      const start = parseSrtTime(startStr);
      const end = parseSrtTime(endStr);
      const textContent = lines.slice(timeLineIdx + 1).join(' ').trim();
      if (!textContent) continue;
      segs.push({ start, duration: end - start, text: textContent });
    }
    return segs;
  };

  const handleSrtUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 현재 대본이 있으면 덮어쓰기 확인
    if (segments.length > 0) {
      if (!confirm('현재 대본이 SRT 파일 내용으로 덮어써집니다. 계속하시겠습니까?')) {
        e.target.value = '';
        return;
      }
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = parseSrt(text);
      if (parsed.length === 0) {
        alert('SRT 파일 파싱에 실패했습니다. 형식을 확인해주세요.');
        return;
      }
      setSegments(parsed);
      setTranscript(parsed.map(s => s.text).join(' '));
      setTranslations({});
      translationsRef.current = {};
      setSegmentsVersion(v => v + 1); // 편집 필드 defaultValue 갱신
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };
  // ================================================================
  // JSX 렌더링
  // ================================================================
  const hasResult = !!transcript;

  return (
    <div className="app-shell">

      {/* ── Whisper 확인 모달 ────────────────────────────────── */}
      <AnimatePresence>
        {showWhisperConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="modal-overlay"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="modal-card"
            >
              <div className="modal-icon">🎙️</div>
              <h2 className="modal-title">자막이 없는 영상입니다</h2>
              <p className="modal-desc">
                YouTube 자막을 찾을 수 없습니다.<br />
                <span style={{ color: 'var(--brand-light)', fontWeight: 600 }}>AI 음성인식(Whisper)</span>으로
                추출할 수 있지만, 영상 길이에 따라{' '}
                <span style={{ color: 'var(--warning)', fontWeight: 600 }}>수 분이 소요</span>될 수 있습니다.
              </p>
              <div className="modal-actions">
                <button className="btn-modal-cancel" onClick={handleWhisperCancel}>취소</button>
                <button className="btn-modal-confirm" onClick={handleWhisperConfirm}>AI로 추출하기</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Top Nav ──────────────────────────────────────────── */}
      <nav className="top-nav">
        <div className="nav-brand">
          <div className="nav-brand-icon">
            <Youtube style={{ width: 15, height: 15 }} />
          </div>
          YouTube Scribe
        </div>
        <span className="nav-badge">Beta</span>
      </nav>

      {/* ── Main Layout ──────────────────────────────────────── */}
      <div className={`main-content${hasResult ? ' has-clip-panel' : ' hero-layout'}`}
        style={hasResult ? {
          gridTemplateColumns: `${leftCollapsed ? '0px' : `${layoutSizes.leftWidth}px`} auto 1fr auto ${clipCollapsed ? '0px' : `${layoutSizes.clipWidth}px`}`
        } : undefined}
      >

        {/* ══ 좌측 패널: 입력 & 컨트롤 ══════════════════════════ */}
        <aside className={`left-panel${hasResult && leftCollapsed ? ' panel-collapsed' : ''}`}>

          {/* Hero 헤딩 (결과 없을 때만) */}
          {!hasResult && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <h1 className="hero-heading">YouTube<br />Scribe</h1>
              <p className="hero-sub">영상 URL만 넣으면 대사를 자동으로 추출해 드립니다</p>
            </motion.div>
          )}

          {/* URL 입력 */}
          <div className="url-input-wrap">
            <p className="section-label">YouTube URL</p>
            <form onSubmit={handleSubmit}>
              <div className="url-field">
                <Youtube style={{ width: 16, height: 16, color: 'var(--text-muted)', flexShrink: 0 }} />
                <input
                  ref={urlInputRef}
                  type="text"
                  autoFocus
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={url}
                  onChange={(e) => {
                    const val = e.target.value;
                    setUrl(val);
                    setAvailableLangs([]);
                    setSelectedLang('');
                    setLangError('');
                    if (langDebounceRef.current) clearTimeout(langDebounceRef.current);
                    if (YT_URL_RE.test(val)) {
                      langDebounceRef.current = setTimeout(() => fetchLanguages(val), 600);
                    }
                  }}
                  disabled={loading}
                />
                <button type="submit" className="btn-extract" disabled={loading || !url}>
                  {loading
                    ? <><Loader2 style={{ width: 13, height: 13, animation: 'spin 0.8s linear infinite' }} /> 추출 중</>
                    : <><Send style={{ width: 13, height: 13 }} /> 추출하기</>
                  }
                </button>
              </div>
            </form>

            {/* 언어 선택 */}
            <AnimatePresence>
              {(langLoading || availableLangs.length > 0 || langError) && (
                <motion.div
                  key="lang"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  style={{ overflow: 'hidden' }}
                >
                  {langLoading ? (
                    <div className="lang-row">
                      <Loader2 style={{ width: 13, height: 13, color: 'var(--brand-light)', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                      <span className="lang-row-label">언어 목록 불러오는 중...</span>
                    </div>
                  ) : langError ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.25rem' }}>
                      <span className="status-chip warn">⚠ 자막 없음 — AI 추출 가능</span>
                    </div>
                  ) : (
                    <div className="lang-row">
                      <span className="lang-row-label">🌐 언어</span>
                      <select
                        className="lang-select"
                        value={selectedLang}
                        onChange={(e) => handleLangChange(e.target.value)}
                        disabled={loading}
                      >
                        <option value="">자동 선택 (권장)</option>
                        {availableLangs.some(l => !l.is_generated) && <option disabled>── 수동 자막 ──</option>}
                        {availableLangs.filter(l => !l.is_generated).map(l => (
                          <option key={l.code} value={l.code}>{l.label}</option>
                        ))}
                        {availableLangs.some(l => l.is_generated) && <option disabled>── 자동 생성 ──</option>}
                        {availableLangs.filter(l => l.is_generated).map(l => (
                          <option key={`auto-${l.code}`} value={l.code}>{l.label}</option>
                        ))}
                      </select>
                      {selectedLang && (
                        <span className="status-chip info">
                          {availableLangs.find(l => l.code === selectedLang)?.name ?? selectedLang}
                        </span>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── 로컬 파일 업로드 (첫 화면에서만) ── */}
          {!hasResult && !loading && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 }}
            >
              <div className="upload-divider">
                <span>또는</span>
              </div>
              <div
                className={`upload-drop-zone${isDragOverUpload ? ' drag-over' : ''}`}
                onClick={() => localFileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragOverUpload(true); }}
                onDragLeave={() => setIsDragOverUpload(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOverUpload(false);
                  const file = e.dataTransfer.files[0];
                  if (file) handleLocalFileUpload(file);
                }}
              >
                <svg style={{ width: 28, height: 28, color: 'var(--text-muted)', marginBottom: 6 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span className="upload-drop-text">로컬 영상/음성 파일을 드래그하거나 클릭하여 업로드</span>
                <span className="upload-drop-formats">.mp4 .webm .mp3 .wav .m4a .ogg .flac</span>
                <span className="upload-drop-hint">AI 음성인식으로 자동 전사됩니다</span>
              </div>
              <button
                className="upload-manual-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.mp4,.webm,.mp3,.wav,.m4a,.ogg,.flac,.mkv,.avi';
                  input.onchange = () => {
                    const file = input.files?.[0];
                    if (file) handleLocalMediaOnly(file);
                  };
                  input.click();
                }}
              >
                📝 전사 없이 업로드 (수동 자막 작업)
              </button>
              <input
                ref={localFileInputRef}
                type="file"
                accept=".mp4,.webm,.mp3,.wav,.m4a,.ogg,.flac,.mkv,.avi"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleLocalFileUpload(file);
                  e.target.value = '';
                }}
              />
            </motion.div>
          )}

          {/* 업로드 진행 상태 */}
          <AnimatePresence>
            {uploadProgress && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="upload-progress"
              >
                <Loader2 style={{ width: 14, height: 14, animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                <span>{uploadProgress}</span>
                {localFileName && <span className="upload-filename">{localFileName}</span>}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 에러 배너 */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="error-banner">
                  <span style={{ flexShrink: 0 }}>⚠</span>
                  {error}
                </div>
              </motion.div>
            )}
          </AnimatePresence>


          {/* ── 다중 구간 패널 (드래그 모드 ON일 때 left panel에 표시) ── */}
          {hasResult && isDragMode && (
            <motion.div
              key="multi-range-section"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              style={{ overflow: 'hidden' }}
              className="controls-block"
            >
              <p className="section-label">
                <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                  <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
                </svg>
                다중 구간 재생
              </p>

              {/* 다중 구간 모드 토글 */}
              <div
                className={`mode-toggle-bar ${isMultiRangeMode ? 'active' : ''}`}
                onClick={() => {
                  const next = !isMultiRangeMode;
                  setIsMultiRangeMode(next);
                  if (next && loopConfig) {
                    // ON: 현재 재생 중인 구간을 첫 항목으로 자동 추가
                    const s = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
                    const e = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
                    setMultiRanges([{ startIdx: s, endIdx: e, repeatCount: 1 }]);
                  } else {
                    // OFF: 초기화
                    setMultiRanges([]);
                  }
                  setActiveMultiRangeIdx(0);
                }}
              >
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon">
                    <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                      <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
                    </svg>
                  </span>
                  <div className="mode-toggle-texts">
                    <span className="mode-toggle-title">다중 구간 모드</span>
                    <span className="mode-toggle-desc">{isMultiRangeMode ? '드래그로 구간 추가' : '여러 구간 순차 재생'}</span>
                  </div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={isMultiRangeMode}
                    onChange={(e) => {
                      e.stopPropagation();
                      const next = e.target.checked;
                      setIsMultiRangeMode(next);
                      if (next && loopConfig) {
                        const s = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
                        const en = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
                        setMultiRanges([{ startIdx: s, endIdx: en, repeatCount: 1 }]);
                      } else {
                        setMultiRanges([]);
                      }
                      setActiveMultiRangeIdx(0);
                    }} />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </div>
              </div>

              {/* 구간 목록 + 설정 (다중 구간 모드 ON일 때) */}
              <AnimatePresence>
                {isMultiRangeMode && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div className="multi-range-panel" style={{ marginLeft: 0, borderLeft: 'none', marginTop: '0.4rem' }}>
                      {multiRanges.length === 0 ? (
                        <p className="multi-range-hint">대본에서 드래그해서 구간을 추가하세요</p>
                      ) : (<>
                        {/* ── 전체 재생 토글 ── */}
                        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.35rem' }}>
                          <button
                            className="sync-btn"
                            style={{
                              flex: 1, height: 26, fontSize: '0.7rem', fontWeight: 600, gap: '0.3rem',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: isPlayAllActive ? 'rgba(99,102,241,0.2)' : undefined,
                              borderColor: isPlayAllActive ? 'rgba(99,102,241,0.5)' : undefined,
                            }}
                            onClick={() => {
                              if (isPlayAllActive) {
                                // ── OFF: 전체 대본 복원 + 현재 구간만 개별 반복 ──
                                isPlayAllRef.current = false;
                                setIsPlayAllActive(false);
                                // 현재 진행 중인 구간을 개별 반복으로 전환
                                const curIdx = activeMultiRangeIdxRef.current;
                                const cur = multiRanges[curIdx];
                                if (cur) {
                                  setLoopConfig({ matchIndex: cur.startIdx, startOffset: 0, endOffset: cur.endIdx - cur.startIdx });
                                }
                              } else {
                                // ── ON: 필터 뷰 + 순차 재생 시작 ──
                                isPlayAllRef.current = true;
                                setIsPlayAllActive(true);
                                setActiveMultiRangeIdx(0);
                                activeMultiRangeIdxRef.current = 0;
                                rangePlayCountRef.current = 0;
                                isInGapRef.current = true;
                                const first = multiRanges[0];
                                setLoopConfig({ matchIndex: first.startIdx, startOffset: 0, endOffset: first.endIdx - first.startIdx });
                                setInteractionMode('play');
                                if (playbackOptionRef.current === 'popup') setPlaybackOption('loop');
                                const startTime = segments[first.startIdx]?.start ?? 0;
                                seekAndPlay(startTime);
                                setTimeout(() => { isInGapRef.current = false; }, 300);
                              }
                              // 자동 스크롤 재활성화
                              if (!isEditModeRef.current) {
                                updateActiveSegDom(-1);
                                programmaticScrollRef.current = true;
                                isAutoScrollRef.current = true; setIsAutoScroll(true);
                                setTimeout(() => { programmaticScrollRef.current = false; }, 600);
                              }
                            }}
                          >
                            {isPlayAllActive ? (
                              <>
                                <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                                전체 재생 중 ({multiRanges.length}개 구간)
                              </>
                            ) : (
                              <>
                                <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                전체 재생 ({multiRanges.length}개 구간)
                              </>
                            )}
                          </button>
                        </div>
                        {/* ── 구간 목록 ── */}
                        <div className="multi-range-list">
                          {multiRanges.map((r, ri) => {
                            const sSeg = segments[r.startIdx];
                            const eSeg = segments[r.endIdx];
                            if (!sSeg) return null;
                            const isPlaying = activeMultiRangeIdx === ri && loopMode;
                            return (
                              <div key={ri} className={`multi-range-item${isPlaying ? ' playing' : ''}`}>
                                {/* 개별 재생 버튼 */}
                                <button
                                  className="sync-btn"
                                  title="이 구간만 반복 재생"
                                  style={{ width: 22, height: 22, flexShrink: 0 }}
                                  onClick={() => {
                                    isPlayAllRef.current = false; // 개별 재생: 순차 전환 비활성
                                    setIsPlayAllActive(false);

                                    setActiveMultiRangeIdx(ri);
                                    activeMultiRangeIdxRef.current = ri;
                                    rangePlayCountRef.current = 0;
                                    isInGapRef.current = true;
                                    setLoopConfig({ matchIndex: r.startIdx, startOffset: 0, endOffset: r.endIdx - r.startIdx });
                                    setInteractionMode('play');
                                    if (playbackOptionRef.current === 'popup') setPlaybackOption('loop');
                                    const startTime = segments[r.startIdx]?.start ?? 0;
                                    seekAndPlay(startTime);
                                    setTimeout(() => { isInGapRef.current = false; }, 300);
                                    // 재생 버튼 클릭 = 명시적 액션 → 자동 스크롤 무조건 재활성화
                                    if (!isEditModeRef.current) {
                                      updateActiveSegDom(-1); // stale 위치로 인한 자동스크롤 해제 방지
                                      programmaticScrollRef.current = true; // 셋업 기간 scroll 이벤트 무시
                                      isAutoScrollRef.current = true; setIsAutoScroll(true);
                                      setTimeout(() => { programmaticScrollRef.current = false; }, 600);
                                    }
                                  }}
                                >
                                  <svg style={{ width: 10, height: 10 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                </button>
                                <span className="multi-range-num" style={{ color: RANGE_COLORS[ri % RANGE_COLORS.length] }}>{ri + 1}</span>
                                <span className="multi-range-time">
                                  {formatTimestamp(sSeg.start)} ~ {formatTimestamp(eSeg.start + eSeg.duration)}
                                </span>
                                <span className="multi-range-repeat">
                                  <button className="sync-btn" style={{ width: 18, height: 18, fontSize: '0.65rem' }}
                                    onClick={() => setMultiRanges(prev => prev.map((rr, ii) => ii === ri ? { ...rr, repeatCount: Math.max(0, (rr.repeatCount ?? 1) - 1) } : rr))}>−</button>
                                  <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', minWidth: '1.2rem', textAlign: 'center' }}>{r.repeatCount ?? 1}</span>
                                  <button className="sync-btn" style={{ width: 18, height: 18, fontSize: '0.65rem' }}
                                    onClick={() => setMultiRanges(prev => prev.map((rr, ii) => ii === ri ? { ...rr, repeatCount: (rr.repeatCount ?? 1) + 1 } : rr))}>+</button>
                                </span>
                                <button className="multi-range-del" title="삭제"
                                  onClick={() => {
                                    const remaining = multiRanges.filter((_, i) => i !== ri);
                                    setMultiRanges(remaining);
                                    setActiveMultiRangeIdx(0);
                                    rangePlayCountRef.current = 0;
                                    if (remaining.length === 0) {
                                      setLoopConfig(null);
                                      isPlayAllRef.current = false; setIsPlayAllActive(false);
                                    } else {
                                      const first = remaining[0];
                                      setLoopConfig({ matchIndex: first.startIdx, startOffset: 0, endOffset: first.endIdx - first.startIdx });
                                    }
                                  }}>✕</button>
                              </div>
                            );
                          })}
                        </div>
                      </>)}
                      <div className="multi-range-gap-row">
                        <span className="sync-label">구간 간격</span>
                        <button className="sync-btn" onClick={() => setRangeGap(v => Math.max(0, +(v - 0.5).toFixed(1)))}> - </button>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', minWidth: '2.5rem', textAlign: 'center' }}>{rangeGap.toFixed(1)}s</span>
                        <button className="sync-btn" onClick={() => setRangeGap(v => Math.min(10, +(v + 0.5).toFixed(1)))}> + </button>
                        <input type="range" min="0" max="10" step="0.5"
                          value={rangeGap} onChange={e => setRangeGap(parseFloat(e.target.value))}
                          className="sync-slider" style={{ flex: 1 }} />
                      </div>
                      {multiRanges.length > 0 && (
                        <button
                          style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.1rem 0' }}
                          onClick={() => { setMultiRanges([]); setActiveMultiRangeIdx(0); rangePlayCountRef.current = 0; setLoopConfig(null); isPlayAllRef.current = false; setIsPlayAllActive(false); }}
                        >구간 전체 삭제</button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* 재생 컨트롤 (결과 있을 때만) */}
          {hasResult && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="controls-block">
              <p className="section-label collapsible-header" onClick={() => setPlayCtrlOpen(v => !v)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                재생 컨트롤
                <svg className={`collapse-chevron ${playCtrlOpen ? 'open' : ''}`} style={{ width: 12, height: 12, marginLeft: 'auto', transition: 'transform 0.2s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </p>
              <AnimatePresence>
              {playCtrlOpen && (
                <motion.div key="play-ctrl-body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div className={`mode-toggle-bar ${isSeekMode ? 'active' : ''}`} onClick={() => { const next = !isSeekMode; setIsSeekMode(next); if (next) { rangeClickRef.current = null; clearRangePins(); setIsDragMode(false); } }}>
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon"><svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>
                  <div className="mode-toggle-texts"><span className="mode-toggle-title">지점 재생</span><span className="mode-toggle-desc">해당 위치부터 재생</span></div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={isSeekMode} onChange={(e) => { e.stopPropagation(); const next = e.target.checked; setIsSeekMode(next); if (next) { rangeClickRef.current = null; clearRangePins(); setIsDragMode(false); } }} />
                  <div className="toggle-track" /><div className="toggle-thumb" />
                </div>
              </div>
              <div className={`mode-toggle-bar ${isDragMode ? 'active' : ''}${isSeekMode ? ' disabled' : ''}`} onClick={() => { if (isSeekMode) return; setIsDragMode(v => { if (v) { rangeClickRef.current = null; } return !v; }); }} style={isSeekMode ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon"><svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-2 2-2-2"/><path d="M15 6l-2-2-2 2"/><path d="M18 15l2-2-2-2"/><path d="M6 15l-2-2 2-2"/></svg></span>
                  <div className="mode-toggle-texts"><span className="mode-toggle-title">구간 재생</span><span className="mode-toggle-desc">{isSeekMode ? '지점 재생 모드에서 비활성' : '클릭/드래그로 구간 지정'}</span></div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={isDragMode} disabled={isSeekMode} onChange={(e) => { e.stopPropagation(); setIsDragMode(e.target.checked); }} />
                  <div className="toggle-track" /><div className="toggle-thumb" />
                </div>
              </div>
              <div className={`mode-toggle-bar ${isTrackingMode ? 'active' : ''}`} onClick={() => setIsTrackingMode(v => !v)}>
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon"><Clock style={{ width: 14, height: 14 }} /></span>
                  <div className="mode-toggle-texts"><span className="mode-toggle-title">위치 트래킹</span><span className="mode-toggle-desc">재생 위치 하이라이트</span></div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={isTrackingMode} onChange={(e) => { e.stopPropagation(); setIsTrackingMode(e.target.checked); }} />
                  <div className="toggle-track" /><div className="toggle-thumb" />
                </div>
              </div>
              <div className={`mode-toggle-bar ${isAutoScroll ? 'active' : ''}${isEditMode ? ' disabled' : ''}`} onClick={() => { if (isEditMode) return; setIsAutoScroll(v => !v); isAutoScrollRef.current = !isAutoScrollRef.current; }} style={isEditMode ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon"><svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span>
                  <div className="mode-toggle-texts"><span className="mode-toggle-title">자동 스크롤</span><span className="mode-toggle-desc">{isEditMode ? '편집 모드에서 비활성' : '재생 위치로 자동 이동'}</span></div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={isAutoScroll} disabled={isEditMode} onChange={(e) => { e.stopPropagation(); setIsAutoScroll(e.target.checked); isAutoScrollRef.current = e.target.checked; }} />
                  <div className="toggle-track" /><div className="toggle-thumb" />
                </div>
              </div>
              {/* 자동 스크롤 자동켜기 토글 */}
              <div className={`mode-toggle-bar sub-toggle ${autoScrollReEnable ? 'active' : ''}${isEditMode ? ' disabled' : ''}`} onClick={() => { if (isEditMode) return; setAutoScrollReEnable(v => !v); autoScrollReEnableRef.current = !autoScrollReEnableRef.current; }} style={isEditMode ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
                <div className="mode-toggle-info">
                  <span className="mode-toggle-icon" style={{ opacity: 0.7 }}>⚡</span>
                  <div className="mode-toggle-texts"><span className="mode-toggle-title">재생 시 자동켜기</span><span className="mode-toggle-desc">{isEditMode ? '편집 모드에서 비활성' : '새 구간 시작 시 자동스크롤 ON'}</span></div>
                </div>
                <div className="toggle">
                  <input type="checkbox" checked={autoScrollReEnable} disabled={isEditMode} onChange={(e) => { e.stopPropagation(); setAutoScrollReEnable(e.target.checked); autoScrollReEnableRef.current = e.target.checked; }} />
                  <div className="toggle-track" /><div className="toggle-thumb" />
                </div>
              </div>
              <AnimatePresence>
                {isTrackingMode && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }} className="sync-adjust-bar">
                    <div className="sync-info">
                      <RotateCcw style={{ width: 12, height: 12, color: 'var(--brand-light)' }} />
                      <span className="sync-label">싱크 조정</span>
                      <span className="sync-value">{trackingOffset > 0 ? `+${trackingOffset.toFixed(1)}s` : `${trackingOffset.toFixed(1)}s`}<span className="sync-hint">({trackingOffset > 0 ? '빨리' : '느리게'})</span></span>
                    </div>
                    <div className="sync-controls">
                      <button className="sync-btn" onClick={() => setTrackingOffset(prev => prev - 0.1)}>-</button>
                      <input type="range" min="-3" max="3" step="0.1" value={trackingOffset} onChange={(e) => setTrackingOffset(parseFloat(e.target.value))} className="sync-slider" />
                      <button className="sync-btn" onClick={() => setTrackingOffset(prev => prev + 0.1)}>+</button>
                      <button className="sync-reset" onClick={() => setTrackingOffset(0.3)}>초기화</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
                </motion.div>
              )}
              </AnimatePresence>
            </motion.div>
          )}
        </aside>

        {/* 좌↔우 드래그 핸들 + 접기/펼치기 화살표 */}
        {hasResult && (
          <div className={`resize-handle-wrapper resize-handle-wrapper-v${leftCollapsed ? ' collapsed' : ''}`}>
            <button
              className="panel-collapse-btn"
              title={leftCollapsed ? '좌측 패널 열기' : '좌측 패널 접기'}
              onClick={() => setLeftCollapsed(v => !v)}
            >
              {leftCollapsed ? '▶' : '◀'}
            </button>
            {!leftCollapsed && <div className="resize-handle resize-handle-v" onMouseDown={handleResizeStart('left')} />}
          </div>
        )}

        {/* ══ 우측 패널: 결과 ════════════════════════════════════ */}
        <main className="right-panel">

          {/* 로딩 */}
          {loading && (
            <div className="loading-state">
              {transcribeProgress > 0 ? (
                <>
                  {/* 퍼센트 프로그레스 바 */}
                  <div className="transcribe-progress-wrapper">
                    <div className="transcribe-progress-bar">
                      <div
                        className="transcribe-progress-fill"
                        style={{ width: `${transcribeProgress}%` }}
                      />
                    </div>
                    <span className="transcribe-progress-percent">{transcribeProgress}%</span>
                  </div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center', maxWidth: 320, margin: 0 }}>
                    {uploadProgress || 'AI 음성인식 전사 중...'}
                    {localFileName && <><br /><span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{localFileName}</span></>}
                  </p>
                </>
              ) : (
                <>
                  <div className="spinner-ring" />
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280, margin: 0 }}>
                    AI가 영상을 분석하고 있습니다.<br />
                    <span style={{ color: 'var(--text-secondary)' }}>영상 길이에 따라 수 분이 소요될 수 있습니다.</span>
                  </p>
                </>
              )}
            </div>
          )}

          {/* 빈 상태 */}
          {!loading && !hasResult && (
            <motion.div
              className="empty-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <div className="empty-state-icon">
                <FileText style={{ width: 22, height: 22 }} />
              </div>
              <p style={{ fontSize: '0.8125rem', margin: 0 }}>
                URL을 입력하고 추출하기를 누르면<br />대사가 여기에 표시됩니다
              </p>
            </motion.div>
          )}

          {/* 결과 영역 */}
          {hasResult && !loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
              {/* 비디오 및 컨트롤 레이아웃 컨테이너 */}
              {/* 플로팅 중이면 최소 도킹 스트립만 표시 — 대본 영역 최대화 */}
              {isVideoFloating && (
                <div
                  ref={videoDockZoneRef}
                  className="video-dock-zone"
                >
                  <svg style={{ width: 14, height: 14, opacity: 0.4 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                  <span>영상을 여기에 놓으면 도킹</span>
                </div>
              )}

              {/* 비디오 컨테이너 — 플로팅/도킹을 CSS position으로 전환 (YouTube 플레이어 유지) */}
              <div
                ref={videoContainerRef}
                className={`video-and-controls${isVideoFloating ? ' floating-video-window' : ''}`}
                style={isVideoFloating ? {
                  left: floatingVideoPos.x,
                  top: floatingVideoPos.y,
                  width: floatingVideoPos.w,
                  height: floatingVideoPos.h,
                } : {
                  height: `${layoutSizes.videoRatio}%`,
                  maxHeight: 'none',
                }}
              >
                {/* 플로팅 상단 드래그 바 */}
                {isVideoFloating && (
                  <div className="floating-video-grab" onMouseDown={handleVideoGrabStart}>
                    <span className="floating-video-grab-dots">⣿⣿⣿</span>
                    <span className="floating-video-title">🎬 영상 플레이어</span>
                    <button
                      className="floating-video-dock-btn"
                      title="원래 위치로 도킹"
                      onClick={(e) => { e.stopPropagation(); setIsVideoFloating(false); }}
                    >
                      ⬓
                    </button>
                  </div>
                )}
                {/* 도킹 상태 그랩 바 */}
                {!isVideoFloating && (
                  <div className="video-grab-bar" onMouseDown={handleVideoGrabStart}>
                    <span className="video-grab-dots">⣿⣿⣿</span>
                  </div>
                )}
                {localMediaUrl ? (
                  <div className="video-section">
                    <video
                      ref={localVideoRef}
                      src={localMediaUrl}
                      controls
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', borderRadius: '0.5rem' }}
                    />
                  </div>
                ) : videoId && (
                  <div className="video-section">
                    <LoopPlayer
                      key={`player-${videoId}`}
                      videoId={videoId}
                      start={loopSegment?.start ?? 0}
                      end={loopSegment?.end ?? 0}
                      playbackMode={
                        !loopMode ? 'none' :
                        isSeekMode ? 'none' :
                        (isMultiRangeMode && multiRanges.length >= 2 && isPlayAllRef.current) ? 'none' :
                        (playbackOption === 'once' ? 'once' : 'loop')
                      }
                      onClose={() => setLoopConfig(null)}
                      formatTimestamp={formatTimestamp}
                      onPlayerReady={(player) => { loopPlayerRef.current = player; }}
                    />
                  </div>
                )}
                {/* 플로팅 리사이즈 핸들 */}
                {isVideoFloating && (
                  <>
                    <div className="floating-resize floating-resize-e" onMouseDown={handleFloatingResize('e')} />
                    <div className="floating-resize floating-resize-s" onMouseDown={handleFloatingResize('s')} />
                    <div className="floating-resize floating-resize-w" onMouseDown={handleFloatingResize('w')} />
                    <div className="floating-resize floating-resize-se" onMouseDown={handleFloatingResize('se')} />
                    <div className="floating-resize floating-resize-sw" onMouseDown={handleFloatingResize('sw')} />
                  </>
                )}
              </div>
              {/* 파형이 있으면: 구분선1(영상↔파형) */}
              {localMediaUrl && !isVideoFloating && (
                <div className="resize-handle resize-handle-h" onMouseDown={handleResizeStart('video')} />
              )}
              {/* 파형 시각화 (로컬 미디어) */}
              {localMediaUrl && (
                <div className="waveform-wrap" style={{ padding: '0.25rem 0.5rem 0' }}>
                  <div ref={waveformContainerRef} className="waveform-container" style={{ height: waveformHeight + 64 }} />
                  {/* Minimap은 WaveSurfer 플러그인이 insertPosition='afterend'로 waveform-container 뒤에 자동 삽입 */}
                </div>
              )}
              {/* 파형 없으면: 구분선(영상↔자막), 파형 있으면: 구분선2(파형↔자막) */}
              {!isVideoFloating && (
                <div
                  className="resize-handle resize-handle-h"
                  onMouseDown={localMediaUrl ? handleWaveformResizeStart : handleResizeStart('video')}
                />
              )}


              {/* 액션 바 */}
              <div className="action-bar">
                <span className="action-bar-title">
                  <FileText style={{ width: 14, height: 14, color: 'var(--brand-light)' }} />
                  {localMediaUrl ? '자막' : '추출된 대사'}
                  {segments.length > 0 && (
                    <span style={{
                      fontSize: '0.7rem', padding: '0.15rem 0.5rem',
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 100, color: 'var(--text-muted)', fontWeight: 500
                    }}>{segments.length}개</span>
                  )}
                </span>
                {/* 수동 자막: 마커 + 컷 */}
                {localMediaUrl && (
                  <div className="marker-bar">
                    <button className={`btn-icon btn-marker${markIn != null ? ' active' : ''}`} onClick={setInMark} title="시작점 (I키)">
                      ▶{markIn != null && <span className="marker-time">{formatTimestamp(markIn)}</span>}
                    </button>
                    <button className={`btn-icon btn-marker${markOut != null ? ' active' : ''}`} onClick={setOutMark} title="끝점 (O키)">
                      ◼{markOut != null && <span className="marker-time">{formatTimestamp(markOut)}</span>}
                    </button>
                    <button className="btn-icon btn-marker-add" onClick={addManualSegment} disabled={markIn == null || markOut == null} title="세그먼트 확정 (P키)">
                      + 확정
                    </button>
                    <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 0.15rem' }} />
                    <button className="btn-icon btn-marker-add" onClick={cutSegment} title="빠른 컷 (C키)">
                      ✂ 컷
                    </button>
                  </div>
                )}
                <button
                  ref={editBtnRef}
                  className="btn-icon"
                  onClick={toggleEditMode}
                  title="세그먼트 편집 모드"
                  disabled={segments.length === 0}
                >
                  <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  편집
                </button>
                {isEditMode && (
                  <>
                  <button
                    className="btn-icon"
                    onClick={() => {
                      if (confirm('편집 내용을 되돌리시겠습니까? 편집 모드 진입 시점으로 복원됩니다.')) {
                        revertEdits();
                      }
                    }}
                    title="편집 되돌리기 (편집 모드 진입 시점으로)"
                  >
                    <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    되돌리기
                  </button>
                  <div ref={editSettingsRef} style={{ position: 'relative' }}>
                    <button
                      className={`btn-icon${showEditSettings ? ' active' : ''}`}
                      onClick={() => setShowEditSettings(v => !v)}
                      title="편집 설정"
                    >
                      <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                      </svg>
                    </button>
                    {showEditSettings && (
                      <div className="edit-settings-dropdown">
                        <label className="edit-settings-item" onClick={() => setWrapEditNav(v => !v)}>
                          <input type="checkbox" checked={wrapEditNav} readOnly />
                          <span>처음↔끝 순환 이동</span>
                        </label>
                      </div>
                    )}
                  </div>
                  </>
                )}
                <button
                  className={`btn-icon${copied ? ' success' : ''}`}
                  onClick={copyToClipboard}
                  title="클립보드에 복사"
                >
                  {copied
                    ? <><CheckCircle2 style={{ width: 13, height: 13 }} /> 복사됨</>
                    : <><Copy style={{ width: 13, height: 13 }} /> 복사</>
                  }
                </button>
                <div className="divider-v" />
                {/* 발음 자막 토글 */}
                <button
                  className={`btn-icon${showTranslation ? ' active' : ''}`}
                  onClick={() => setShowTranslation(v => !v)}
                  title="발음 자막 편집"
                >
                  <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5h7"/><path d="M9 3v2"/><path d="M4 11l3-3 3 3"/>
                    <path d="M12.5 7.5l4 8"/><path d="M14 14h5"/>
                  </svg>
                  발음
                </button>
                {showTranslation && (
                  <>
                    <button
                      className="btn-icon"
                      onClick={() => {
                        const result: Record<number, string> = {};
                        segments.forEach((seg, i) => {
                          result[i] = romanize(seg.text.trim());
                        });
                        setTranslations(result);
                      }}
                      title="한글 → 로마자 자동 변환"
                    >
                      한→영
                    </button>
                    <button
                      className="btn-icon"
                      onClick={() => {
                        const result: Record<number, string> = {};
                        segments.forEach((seg, i) => {
                          result[i] = englishToKorean(seg.text.trim());
                        });
                        setTranslations(result);
                      }}
                      title="영어 → 한글 발음 자동 변환"
                    >
                      영→한
                    </button>
                    <button
                      className="btn-icon"
                      onClick={downloadSrt}
                      title="SRT 발음 자막 내보내기"
                    >
                      <Download style={{ width: 13, height: 13 }} />
                      SRT
                    </button>
                    <button
                      className="btn-icon"
                      onClick={() => srtInputRef.current?.click()}
                      title="SRT 자막 파일 불러오기"
                    >
                      <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      SRT
                    </button>
                    <input
                      ref={srtInputRef}
                      type="file"
                      accept=".srt"
                      style={{ display: 'none' }}
                      onChange={handleSrtUpload}
                    />
                  </>
                )}
                <div className="divider-v" />
                {/* 저장 옵션 드롭다운 */}
                <div ref={saveOptionsRef} style={{ position: 'relative', display: 'flex', alignItems: 'stretch', gap: '0.375rem' }}>
                  <button className="btn-icon" onClick={downloadTxt} title="TXT 파일로 저장">
                    <Download style={{ width: 13, height: 13 }} />
                    {includeTimestamps ? '저장 (타임스탬프)' : '저장'}
                  </button>
                  <button
                    className={`btn-icon save-opts-trigger${showSaveOptions ? ' active' : ''}`}
                    onClick={() => setShowSaveOptions(v => !v)}
                    title="저장 옵션"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                  </button>

                  {/* Floating 드롭다운 패널 */}
                  <AnimatePresence>
                    {showSaveOptions && (
                      <motion.div
                        key="save-options-popup"
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                        className="save-options-popup"
                      >
                        <p className="save-opts-title">저장 옵션</p>

                        {/* 타임스탬프 토글 */}
                        <label className="control-row" style={{ cursor: 'pointer' }}>
                          <span className="control-row-label">
                            <Clock style={{ width: 13, height: 13, color: 'var(--brand-light)' }} />
                            타임스탬프 포함
                          </span>
                          <div className="toggle">
                            <input type="checkbox" checked={includeTimestamps} onChange={() => setIncludeTimestamps(v => !v)} />
                            <div className="toggle-track" />
                            <div className="toggle-thumb" />
                          </div>
                        </label>

                        {/* 타임스탬프 정밀도 */}
                        <AnimatePresence>
                          {includeTimestamps && (
                            <motion.div
                              key="ts-prec"
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div className="control-row" style={{ alignItems: 'center', paddingTop: 0 }}>
                                <span className="control-row-label" style={{ fontSize: '0.75rem' }}>정밀도</span>
                                <div className="precision-chips">
                                  {[0,1,2,3].map(p => (
                                    <button
                                      key={p}
                                      className={`precision-btn ${timestampPrecision === p ? 'active' : ''}`}
                                      onClick={() => setTimestampPrecision(p)}
                                    >
                                      {p === 0 ? '초' : `.${'0'.repeat(p)}s`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div style={{ padding: '0 0.5rem 0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'right' }}>
                                미리보기: [{formatTimestamp(125.456)}]
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {/* 미니맵 높이 조절 (로컬 미디어일 때만) */}
                        {localMediaUrl && (
                          <label className="control-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '0.25rem 0.5rem' }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>미니맵 높이: {minimapHeight}px</span>
                            <input
                              type="range"
                              min={10}
                              max={60}
                              value={minimapHeight}
                              onChange={e => setMinimapHeight(parseInt(e.target.value))}
                              style={{ width: '100%', accentColor: 'var(--brand)' }}
                            />
                          </label>
                        )}

                        {/* 줄바꿈 토글 */}
                        <label className="control-row" style={{ cursor: 'pointer' }}>
                          <span className="control-row-label">
                            <svg style={{ width: 13, height: 13, color: lineBreak ? 'var(--brand-light)' : 'var(--text-muted)', flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                            </svg>
                            줄바꿈
                          </span>
                          <div className="toggle">
                            <input type="checkbox" checked={lineBreak} onChange={() => setLineBreak(v => !v)} />
                            <div className="toggle-track" />
                            <div className="toggle-thumb" />
                          </div>
                        </label>

                        {/* 빈 줄 수 */}
                        <AnimatePresence>
                          {(lineBreak || includeTimestamps) && (
                            <motion.div
                              key="lbc"
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div className="control-row" style={{ alignItems: 'center' }}>
                                <span className="control-row-label" style={{ fontSize: '0.75rem' }}>세그먼트 사이 빈 줄</span>
                                <div style={{ display: 'flex', gap: '0.2rem' }}>
                                  {[0,1,2,3].map(n => (
                                    <button
                                      key={n}
                                      onClick={() => setLineBreakCount(n)}
                                      style={{
                                        width: 26, height: 24, borderRadius: 5,
                                        border: lineBreakCount === n ? '1px solid var(--brand)' : '1px solid var(--border-strong)',
                                        background: lineBreakCount === n ? 'rgba(99,102,241,0.2)' : 'var(--surface-2)',
                                        color: lineBreakCount === n ? 'var(--brand-light)' : 'var(--text-muted)',
                                        fontSize: '0.7rem', fontWeight: lineBreakCount === n ? 700 : 400,
                                        cursor: 'pointer', transition: 'all 0.15s',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      }}
                                    >
                                      {n === 0 ? '없음' : `${n}줄`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="divider-v" />
                {/* ── 대본 저장/불러오기 ── */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <button className="btn-icon" onClick={handleSaveScript} title="현재 대본 저장" disabled={segments.length === 0}>
                    <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                    {activeScriptId ? '덮어쓰기' : '저장'}
                  </button>
                  <button
                    className={`btn-icon${showScriptsPanel ? ' active' : ''}`}
                    onClick={() => { savedScriptsRef.current = loadAllScripts(); forceScriptsUpdate(n => n + 1); setShowScriptsPanel(v => !v); }}
                    title="저장된 대본 관리"
                  >
                    <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    목록
                  </button>

                  {/* 대본 관리 플로팅 패널 */}
                  <AnimatePresence>
                    {showScriptsPanel && (
                      <motion.div
                        key="scripts-panel"
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                        className="floating-panel scripts-floating"
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>저장된 대본</span>
                          <button className="floating-close" onClick={() => setShowScriptsPanel(false)}>✕</button>
                        </div>

                        {/* 제목 입력 */}
                        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem' }}>
                          <input
                            ref={scriptTitleRef}
                            defaultValue=""
                            placeholder="대본 제목..."
                            style={{
                              flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border-strong)',
                              borderRadius: 'var(--radius-sm)', padding: '0.3rem 0.5rem', fontSize: '0.72rem',
                              color: 'var(--text-primary)', outline: 'none',
                            }}
                          />
                          <button className="btn-icon" onClick={handleSaveScript} disabled={segments.length === 0}
                            style={{ fontSize: '0.65rem', padding: '0.25rem 0.5rem' }}>
                            {activeScriptId ? '덮어쓰기' : '새로 저장'}
                          </button>
                        </div>

                        {/* 목록 */}
                        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                          {savedScriptsRef.current.length === 0 ? (
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>저장된 대본이 없습니다.</p>
                          ) : (
                            savedScriptsRef.current
                              .filter(s => !videoId || s.videoId === videoId)
                              .map(s => (
                                <div key={s.id} className={`script-item${activeScriptId === s.id ? ' active' : ''}`}>
                                  <div style={{ flex: 1, minWidth: 0 }} onClick={() => handleLoadScript(s)}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                                      {s.segments.length}개 세그먼트 · {new Date(s.updatedAt).toLocaleDateString('ko')}
                                    </div>
                                  </div>
                                  <button className="floating-close" onClick={() => handleDeleteScript(s.id)} title="삭제">✕</button>
                                </div>
                              ))
                          )}
                          {videoId && savedScriptsRef.current.some(s => s.videoId !== videoId) && (
                            <details style={{ marginTop: '0.4rem' }}>
                              <summary style={{ fontSize: '0.65rem', color: 'var(--text-muted)', cursor: 'pointer' }}>다른 영상 대본 ({savedScriptsRef.current.filter(s => s.videoId !== videoId).length})</summary>
                              {savedScriptsRef.current.filter(s => s.videoId !== videoId).map(s => (
                                <div key={s.id} className="script-item" style={{ opacity: 0.7 }}>
                                  <div style={{ flex: 1, minWidth: 0 }} onClick={() => handleLoadScript(s)}>
                                    <div style={{ fontSize: '0.72rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{s.videoId}</div>
                                  </div>
                                  <button className="floating-close" onClick={() => handleDeleteScript(s.id)}>✕</button>
                                </div>
                              ))}
                            </details>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className="divider-v" />
                {/* ── 검색 영역 ── */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <div className="search-field-inline">
                    <Search style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="검색..."
                      defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value.trim()) {
                          searchQueryRef.current = '';
                          setSearchResults([]);
                          setShowSearchResults(false);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleSearch();
                          setShowSearchResults(true);
                        }
                      }}
                    />
                    <button className="btn-search" onClick={() => { handleSearch(); setShowSearchResults(true); }}>
                      <Search style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                  {/* 검색 옵션 */}
                  <div ref={searchOptsRef} style={{ position: 'relative' }}>
                  <button
                    className={`btn-icon${showSearchOpts ? ' active' : ''}`}
                    onClick={() => setShowSearchOpts(v => !v)}
                    title="검색 설정"
                  >
                    <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  </button>
                  <AnimatePresence>
                    {showSearchOpts && (
                      <motion.div
                        key="search-opts"
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                        className="floating-panel"
                        style={{ minWidth: 220, right: 'auto', left: 0 }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>검색 설정</span>
                          <button className="floating-close" onClick={() => setShowSearchOpts(false)}>✕</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0' }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>유사 포함</span>
                          <div className={`toggle-mini ${fuzzySearch ? 'active' : ''}`} onClick={() => setFuzzySearch(v => !v)}>
                            <div className="toggle-mini-track" /><div className="toggle-mini-thumb" />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0' }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>검색 구간</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <button style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.7rem' }} onClick={() => setSearchRange(v => Math.max(1, v - 1))}>−</button>
                            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: 24, textAlign: 'center' }}>{searchRange}</span>
                            <button style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.7rem' }} onClick={() => setSearchRange(v => Math.min(50, v + 1))}>+</button>
                          </div>
                        </div>
                        {fuzzySearch && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0' }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>유사도</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                              <input
                                type="range" min="0.1" max="0.8" step="0.05"
                                value={fuzzyThreshold}
                                onChange={e => setFuzzyThreshold(parseFloat(e.target.value))}
                                style={{ width: 70, accentColor: 'var(--brand)' }}
                              />
                              <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: 28, textAlign: 'right' }}>{fuzzyThreshold.toFixed(2)}</span>
                            </div>
                          </div>
                        )}
                        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', margin: '0.3rem 0 0', lineHeight: 1.4 }}>
                          {fuzzySearch ? `유사도 ${fuzzyThreshold.toFixed(2)}: 낮을수록 정확, 높을수록 느슨` : '정확 일치 검색'}<br/>
                          구간: {searchRange}개 세그먼트 범위 내 매칭
                        </p>
                        <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.4rem', paddingTop: '0.4rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>레이아웃</span>
                            <button
                              style={{ fontSize: '0.62rem', padding: '0.15rem 0.4rem', borderRadius: 4, border: '1px solid var(--border-strong)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}
                              onClick={resetLayout}
                            >기본값 초기화</button>
                          </div>
                          <p style={{ fontSize: '0.58rem', color: 'var(--text-muted)', margin: '0.2rem 0 0' }}>
                            패널 경계를 드래그하여 크기 조절
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  </div>
                  {/* 모드 토글 버튼 */}
                  <button
                    className={`btn-icon${showModePanel ? ' active' : ''}`}
                    onClick={() => setShowModePanel(v => !v)}
                    title="클릭 동작 설정"
                  >
                    {interactionMode === 'search'
                      ? <><Search style={{ width: 11, height: 11 }} /> 검색</>
                      : <><Youtube style={{ width: 11, height: 11 }} /> 재생</>
                    }
                  </button>

                  {/* 모드 플로팅 패널 */}
                  <AnimatePresence>
                    {showModePanel && (
                      <motion.div
                        key="mode-popup"
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                        className="floating-panel mode-floating"
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>클릭 동작</span>
                          <button className="floating-close" onClick={() => setShowModePanel(false)}>✕</button>
                        </div>
                        <div className="mode-tabs">
                          <button className={`mode-tab ${interactionMode === 'search' ? 'active' : ''}`}
                            onClick={() => { setInteractionMode('search'); setShowModePanel(false); }}>
                            <Search style={{ width: 12, height: 12 }} /> 검색 모드
                          </button>
                          <button className={`mode-tab ${interactionMode === 'play' ? 'active' : ''}`}
                            onClick={() => { setInteractionMode('play'); setShowModePanel(false); }}>
                            <Youtube style={{ width: 12, height: 12 }} /> 재생 모드
                          </button>
                        </div>
                        {interactionMode === 'play' && (
                          <div className="playback-options" style={{ marginTop: '0.4rem' }}>
                            <label className="play-opt">
                              <input type="radio" name="play-type" checked={playbackOption === 'loop'} onChange={() => setPlaybackOption('loop')} />
                              <span className="play-opt-box"><RotateCcw style={{ width: 11, height: 11 }} /> 반복</span>
                            </label>
                            <label className="play-opt">
                              <input type="radio" name="play-type" checked={playbackOption === 'once'} onChange={() => setPlaybackOption('once')} />
                              <span className="play-opt-box"><svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> 1회</span>
                            </label>
                            <label className="play-opt">
                              <input type="radio" name="play-type" checked={playbackOption === 'popup'} onChange={() => setPlaybackOption('popup')} />
                              <span className="play-opt-box"><svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> 팝업</span>
                            </label>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* 검색 결과 플로팅 패널 */}
                  <AnimatePresence>
                    {showSearchResults && (searchResults.length > 0 || (searchQueryRef.current && searchResults.length === 0)) && (
                      <motion.div
                        key="search-results-float"
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.15 }}
                        className="floating-panel search-results-floating"
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem', flexShrink: 0 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <Clock style={{ width: 11, height: 11 }} />
                            {searchResults.length}개 결과
                          </span>
                          <button className="floating-close" onClick={() => setShowSearchResults(false)}>✕</button>
                        </div>
                        {searchResults.length > 0 ? (
                          <div className="search-results-panel">
                            {searchResults.map((result, idx) => (
                              <div
                                key={`${result.matchIndex}-${idx}`}
                                onClick={() => {
                                  openYouTubeAtTime(
                                    result.loopStartIdx,
                                    segments[result.loopStartIdx]?.start ?? result.segment.start,
                                    { startIdx: result.loopStartIdx, endIdx: result.loopEndIdx },
                                  );
                                  // 기존 하이라이트 제거
                                  segmentRefs.current.forEach(el => el?.classList.remove('search-highlight'));
                                  // 해당 구간 하이라이트 + 스크롤
                                  for (let si = result.loopStartIdx; si <= result.loopEndIdx; si++) {
                                    segmentRefs.current[si]?.classList.add('search-highlight');
                                  }
                                  segmentRefs.current[result.loopStartIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }}
                                className={`search-result-item${
                                  loopMode && loopConfig &&
                                  loopConfig.matchIndex >= result.loopStartIdx &&
                                  loopConfig.matchIndex + loopConfig.endOffset <= result.loopEndIdx
                                    ? ' playing' : ''
                                }`}
                              >
                                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: '0.15rem' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <span className="timestamp-badge">{formatTimestamp(segments[result.loopStartIdx]?.start ?? result.segment.start)}</span>
                                    <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>~</span>
                                    <span className="timestamp-badge">{formatTimestamp(segments[result.loopEndIdx]?.start ?? result.segment.start)}</span>
                                    <span style={{ fontSize: '0.55rem', color: result.score === 0 ? 'var(--brand-light)' : result.score <= 0.01 ? '#6ee7b7' : 'var(--text-muted)', opacity: 0.8, flexShrink: 0, marginLeft: 'auto' }}>
                                      {result.score === 0 ? '정확' : result.score <= 0.01 ? '단어' : result.score.toFixed(2)}
                                    </span>
                                  </div>
                                  <p className="search-result-text" style={{ fontSize: '0.68rem', lineHeight: 1.35 }}>
                                    {highlightText(
                                      segments.slice(result.loopStartIdx, result.loopEndIdx + 1).map(s => s.text.trim()).join(' '),
                                      searchQueryRef.current
                                    )}
                                  </p>
                                </div>
                                <button className="btn-result-loop" title="반복 재생"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const base = result.loopStartIdx;
                                    const endOffset = Math.max(0, result.loopEndIdx - base);
                                    setLoopConfig({ matchIndex: base, startOffset: 0, endOffset });
                                    setInteractionMode('play');
                                    if (playbackOption === 'popup') setPlaybackOption('loop');
                                    seekAndPlay(segments[base]?.start ?? 0);
                                    segmentRefs.current.forEach(el => el?.classList.remove('search-highlight'));
                                    for (let si = result.loopStartIdx; si <= result.loopEndIdx; si++) segmentRefs.current[si]?.classList.add('search-highlight');
                                    segmentRefs.current[result.loopStartIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  }}>
                                  <RotateCcw style={{ width: 12, height: 12 }} />
                                </button>
                                <button className="btn-result-loop" title={`${formatTimestamp(segments[result.loopStartIdx]?.start ?? result.segment.start)}부터 재생`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const startTime = segments[result.loopStartIdx]?.start ?? result.segment.start;
                                    const player = loopPlayerRef.current;
                                    if (player?.seekTo) { player.seekTo(startTime, true); player.playVideo(); }
                                    segmentRefs.current.forEach(el => el?.classList.remove('search-highlight'));
                                    for (let si = result.loopStartIdx; si <= result.loopEndIdx; si++) segmentRefs.current[si]?.classList.add('search-highlight');
                                    segmentRefs.current[result.loopStartIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  }}>
                                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ padding: '0.5rem 0', fontSize: '0.75rem', color: 'var(--warning)' }}>
                            "{searchQueryRef.current}" 검색 결과가 없습니다.
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* 전체 선택 바 (상단 고정) */}
              {loopMode && segments.length > 0 && (
                <div className="select-all-bar">
                  <button
                    className={`seg-check${checkedSegs.size === segments.length ? ' seg-check--on' : ''}`}
                    onClick={() => handleSelectAll(checkedSegs.size !== segments.length)}
                    title={checkedSegs.size === segments.length ? '전체 해제' : '전체 선택'}
                  />
                  <span className="select-all-label" onClick={() => handleSelectAll(checkedSegs.size !== segments.length)}>
                    전체 {checkedSegs.size === segments.length ? '해제' : '선택'} 
                    <span className="select-count">({checkedSegs.size}/{segments.length})</span>
                  </span>
                </div>
              )}

              {/* 자막 — 세그먼트별 렌더링 (하이라이트 + 재생 위치 추적) */}
              <div 
                ref={transcriptScrollRef}
                className={`transcript-scroll${isDragMode ? ' drag-mode' : ''}${isSeekMode ? ' seek-mode' : ''}${loopMode ? ' loop-mode' : ''}${showTranslation ? ' show-translation' : ''}${isEditMode ? ' edit-mode' : ''}`}
                onMouseUp={handleDragEnd}
                onMouseLeave={handleDragEnd}
                onWheel={handleTranscriptWheel}
              >
                {segments.length === 0 ? (
                  <p className="transcript-text">{transcript}</p>
                ) : (
                  <div
                    className="transcript-segments"
                    style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
                  >
                    {/* 연대기 오버레이: 각 구간을 세로 직선으로 표시 (가시 영역 기반) */}
                    {isMultiRangeMode && (() => {
                      const vItems = virtualizer.getVirtualItems();
                      if (vItems.length === 0) return null;
                      return multiRanges.map((r, ri) => {
                        // displaySegMap 모드면 가상 인덱스로 변환
                        const startVi = displaySegMap ? displaySegMap.indexOf(r.startIdx) : r.startIdx;
                        const endVi = displaySegMap ? displaySegMap.indexOf(r.endIdx) : r.endIdx;
                        // 가시 영역에 속하는 아이템 필터
                        const inView = vItems.filter(vi => vi.index >= startVi && vi.index <= endVi);
                        if (inView.length === 0) return null;
                        const top = inView[0].start;
                        const last = inView[inView.length - 1];
                        const height = last.start + last.size - top;
                        const isActive = ri === activeMultiRangeIdx && loopMode;
                        return (
                          <div
                            key={`range-line-${ri}`}
                            style={{
                              position: 'absolute',
                              left: ri * 5 + 2,
                              top,
                              width: isActive ? 4 : 2,
                              height,
                              background: RANGE_COLORS[ri % RANGE_COLORS.length],
                              opacity: isActive ? 0.85 : 0.35,
                              borderRadius: 1,
                              pointerEvents: 'none',
                              zIndex: 2,
                              transition: 'width 0.15s, opacity 0.15s',
                            }}
                          />
                        );
                      });
                    })()}
                    {virtualizer.getVirtualItems().map(virtualRow => {
                      const i = displaySegMap ? displaySegMap[virtualRow.index] : virtualRow.index;
                      const seg = segments[i];
                      if (!seg) return null;
                      const isHit = hitSet.has(i);
                      return (
                        <div
                          key={i}
                          ref={(el) => {
                            segmentRefs.current[i] = el;
                            virtualizer.measureElement(el);
                          }}
                          data-index={i}
                          className={`transcript-seg${isHit ? ' hit' : ''}`}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          onMouseDown={() => { if (!isSeekModeRef.current) handleDragStart(i); }}
                          onMouseEnter={() => { if (!isSeekModeRef.current) handleDragEnter(i); }}
                          onClick={() => {
                            if (!isSeekModeRef.current) return;
                            setLoopConfig(null);
                            setReEnableTrigger(v => v + 1);
                            seekAndPlay(seg.start);
                          }}
                        >
                          <button
                            className="seg-check"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); handleSegToggle(i); }}
                          />
                          <button
                            className="seg-timestamp seg-time-display"
                            onClick={(e) => { if (isSeekModeRef.current) e.stopPropagation(); openYouTubeAtTime(i, seg.start); }}
                            title={loopMode ? '클릭 → 이 세그먼트 재생' : '클릭 → YouTube에서 열기'}
                          >
                            {formatTimestamp(seg.start)}<span className="seg-time-sep">~</span>{formatTimestamp(seg.start + seg.duration)}
                          </button>
                          <input
                            key={`time-${i}-${segmentsVersion}`}
                            className="seg-timestamp seg-edit-time"
                            type="text"
                            defaultValue={seg.start.toFixed(2)}
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value);
                              if (!isNaN(v) && v !== seg.start) {
                                setSegments(prev => prev.map((s, j) => j === i ? { ...s, start: v } : s));
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="시작 시간 (초)"
                          />
                          <span className="seg-text seg-text-display">
                            {highlightText(seg.text.trim(), searchQueryRef.current && searchResults.length > 0 ? searchQueryRef.current : '')}
                          </span>
                          <input
                            key={`text-${i}-${segmentsVersion}`}
                            className="seg-text seg-edit-text"
                            type="text"
                            defaultValue={seg.text.trim()}
                            onKeyDown={(e) => handleEditKeyDown(e, i)}
                            onBlur={(e) => {
                              const v = e.target.value;
                              if (v !== seg.text) {
                                setSegments(prev => prev.map((s, j) => j === i ? { ...s, text: v } : s));
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          />
                          <input
                            className="seg-translation"
                            type="text"
                            placeholder="발음 입력..."
                            defaultValue={translations[i] || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              translationsRef.current = { ...translationsRef.current, [i]: val };
                              setTranslations(prev => ({ ...prev, [i]: val }));
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </motion.div>
          )}
        </main>


        {/* ══ 3번째 패널: 클립 다운로드 ══════════════════════════ */}
        {hasResult && (
          <>
          {/* 우↔클립 드래그 핸들 + 접기/펼치기 화살표 */}
          <div className={`resize-handle-wrapper resize-handle-wrapper-v${clipCollapsed ? ' collapsed' : ''}`}>
            {!clipCollapsed && <div className="resize-handle resize-handle-v" onMouseDown={handleResizeStart('clip')} />}
            <button
              className="panel-collapse-btn"
              title={clipCollapsed ? '클립 패널 열기' : '클립 패널 접기'}
              onClick={() => setClipCollapsed(v => !v)}
            >
              {clipCollapsed ? '◀' : '▶'}
            </button>
          </div>
          <aside className={`clip-panel${clipCollapsed ? ' panel-collapsed' : ''}`}>
            <p className="section-label" style={{ marginBottom: '0.25rem', flexShrink: 0 }}>
              <Download style={{ width: 11, height: 11 }} />
              클립 다운로드
            </p>

            {!(loopMode && loopConfig && loopSegment) ? (
              <div className="clip-panel-empty">
                <svg style={{ width: 32, height: 32 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span>검색 결과에서 ▶ 버튼을 눌러<br/>구간을 선택하면<br/>여기서 클립을 다운로드할 수 있어요</span>
              </div>
            ) : (
              <>
                {/* 구간 표시 */}
                <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--brand-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>선택 구간</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {formatTimestamp(loopSegment.start)} ~ {formatTimestamp(loopSegment.end)}
                    <span style={{ marginLeft: '0.35rem', opacity: 0.7 }}>({Math.floor(loopSegment.end - loopSegment.start)}s)</span>
                  </span>
                </div>

                {/* 구간 실시간 조정 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flexShrink: 0 }}>
                  <p className="section-label" style={{ fontSize: '0.63rem' }}>구간 조정</p>
                  <div className="loop-ctrl-row">
                    <span className="loop-ctrl-label">시작</span>
                    <button className="btn-loop-step" onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.min(c.startOffset + 1, c.matchIndex) } : null)} disabled={loopSegment.startSegIdx === 0}>◀</button>
                    <div className="loop-ctrl-preview">
                      <span className="loop-ctrl-time">{formatTimestamp(loopSegment.startSeg.start)}</span>
                      <span className="loop-ctrl-text">{loopSegment.startSeg.text.trim()}</span>
                    </div>
                    <button className="btn-loop-step" onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.max(0, c.startOffset - 1) } : null)} disabled={!loopConfig || loopConfig.startOffset === 0}>▶</button>
                  </div>
                  <div className="loop-ctrl-row">
                    <span className="loop-ctrl-label">종료</span>
                    <button className="btn-loop-step" onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.max(0, c.endOffset - 1) } : null)} disabled={!loopConfig || loopConfig.endOffset === 0}>◀</button>
                    <div className="loop-ctrl-preview">
                      <span className="loop-ctrl-time">{formatTimestamp(loopSegment.endSeg.start + loopSegment.endSeg.duration)}</span>
                      <span className="loop-ctrl-text">{loopSegment.endSeg.text.trim()}</span>
                    </div>
                    <button className="btn-loop-step" onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.min(c.endOffset + 1, segments.length - 1 - c.matchIndex) } : null)} disabled={loopSegment.endSegIdx >= segments.length - 1}>▶</button>
                  </div>
                </div>

                {/* 다운로드 설정 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem', flexShrink: 0 }}>
                  <p className="section-label" style={{ fontSize: '0.63rem' }}>다운로드 설정</p>
                  <select value={clipQuality} onChange={(e) => setClipQuality(e.target.value as typeof clipQuality)}
                    style={{ fontSize: '0.78rem', padding: '0.4rem 0.5rem', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', width: '100%' }}>
                    <option value="360">360p</option>
                    <option value="480">480p</option>
                    <option value="720">720p (권장)</option>
                    <option value="1080">1080p</option>
                    <option value="best">최고화질</option>
                    <option value="vertical">📱 세로 (쇼츠/릴스)</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem 0' }}>
                    <input type="checkbox" checked={burnSubs} onChange={(e) => setBurnSubs(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                    🔥 자막 굽기
                  </label>
                </div>

                {/* 자막 스타일 (burnSubs ON일 때만) */}
                <AnimatePresence>
                  {burnSubs && (
                    <motion.div key="sub-style" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden', flexShrink: 0 }}>
                      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.65rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <p className="section-label" style={{ fontSize: '0.63rem' }}>자막 스타일</p>
                        <label style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>크기
                          <input type="range" min={16} max={48} step={2} value={subStyle.fontSize} onChange={(e) => setSubStyle(s => ({ ...s, fontSize: Number(e.target.value) }))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
                          <span style={{ fontSize: '0.7rem', minWidth: 22 }}>{subStyle.fontSize}</span>
                        </label>
                        <label style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>위치
                          <select value={subStyle.position} onChange={(e) => setSubStyle(s => ({ ...s, position: e.target.value as typeof s.position }))} style={{ flex: 1, fontSize: '0.77rem', padding: '0.25rem 0.35rem', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)' }}>
                            <option value="top">상단</option><option value="middle">중앙</option><option value="bottom">하단</option>
                          </select>
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.77rem', color: 'var(--text-secondary)' }}>색상</span>
                          {(['white', 'yellow', 'black'] as const).map(c => (
                            <button key={c} onClick={() => setSubStyle(s => ({ ...s, color: c }))} style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${subStyle.color === c ? 'var(--accent)' : 'var(--border)'}`, background: c === 'white' ? '#fff' : c === 'yellow' ? '#ffff00' : '#111', cursor: 'pointer' }} />
                          ))}
                          <label style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', marginLeft: '0.2rem' }}>
                            <input type="checkbox" checked={subStyle.bold} onChange={(e) => setSubStyle(s => ({ ...s, bold: e.target.checked }))} style={{ accentColor: 'var(--accent)', width: 12, height: 12 }} />굵게
                          </label>
                          <label style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={subStyle.background} onChange={(e) => setSubStyle(s => ({ ...s, background: e.target.checked }))} style={{ accentColor: 'var(--accent)', width: 12, height: 12 }} />배경
                          </label>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 다운로드 버튼 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: 'auto', paddingTop: '0.5rem', flexShrink: 0 }}>
                  <button className="btn-icon" style={{ width: '100%', justifyContent: 'center', gap: '0.4rem', padding: '0.5rem' }}
                    title={`${formatTimestamp(loopSegment.start)} ~ ${formatTimestamp(loopSegment.end)} MP4 다운로드`}
                    onClick={async () => {
                      const filename = `clip_${videoId}_${Math.floor(loopSegment.start)}s-${Math.floor(loopSegment.end)}s.mp4`;
                      const clipBody = { url: `https://www.youtube.com/watch?v=${videoId}`, start: loopSegment.start, end: loopSegment.end, quality: clipQuality };
                      if ('showSaveFilePicker' in window) {
                        try {
                          const fh = await (window as any).showSaveFilePicker({ suggestedName: filename, types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }] });
                          alert('클립을 준비 중입니다. 완료되면 자동으로 저장됩니다 (수십 초 소요).');
                          const res = await fetch('http://localhost:8000/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clipBody) });
                          if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `오류 ${res.status}`); }
                          const w = await fh.createWritable(); await res.body!.pipeTo(w); alert('클립 저장 완료!');
                        } catch (e: any) { if (e?.name !== 'AbortError') alert(`클립 다운로드 실패: ${e.message}`); }
                      } else {
                        try {
                          alert('클립을 준비 중입니다.');
                          const res = await fetch('http://localhost:8000/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clipBody) });
                          if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `오류 ${res.status}`); }
                          const blob = await res.blob();
                          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
                          setTimeout(() => URL.revokeObjectURL(a.href), 100);
                        } catch (e: any) { alert(`실패: ${(e as any).message}`); }
                      }
                    }}>
                    <Download style={{ width: 13, height: 13 }} />
                    클립 다운로드
                  </button>

                  {burnSubs && (
                    <button className="btn-icon" style={{ width: '100%', justifyContent: 'center', gap: '0.4rem', padding: '0.5rem', background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--text-primary)' }}
                      title="자막을 영상에 직접 구워서 저장"
                      onClick={async () => {
                        const subSegs: { start: number; end: number; text: string }[] = [];
                        for (let si = loopSegment.startSegIdx; si <= loopSegment.endSegIdx; si++) {
                          const seg = segments[si]; const text = translations[si] || seg.text;
                          if (text.trim()) subSegs.push({ start: Math.max(0, seg.start - loopSegment.start), end: Math.max(0, (seg.start + seg.duration) - loopSegment.start), text: text.trim() });
                        }
                        if (subSegs.length === 0) { alert('자막 데이터가 없습니다.'); return; }
                        const filename = `burned_${videoId}_${Math.floor(loopSegment.start)}s-${Math.floor(loopSegment.end)}s.mp4`;
                        if ('showSaveFilePicker' in window) {
                          try {
                            const fh = await (window as any).showSaveFilePicker({ suggestedName: filename, types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }] });
                            alert('자막을 굽고 있습니다 (수십 초~수분 소요).');
                            const res = await fetch('http://localhost:8000/clip-burn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, start: loopSegment.start, end: loopSegment.end, quality: clipQuality, subtitle_segments: subSegs, style: subStyle }) });
                            if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `오류 ${res.status}`); }
                            const w = await fh.createWritable(); await res.body!.pipeTo(w); alert('자막 굽기 완료!');
                          } catch (e: any) { if (e?.name !== 'AbortError') alert(`자막 굽기 실패: ${e.message}`); }
                        } else { alert('이 브라우저는 파일 저장 대화상자를 지원하지 않습니다.'); }
                      }}>
                      🔥 자막 굽기
                    </button>
                  )}
                </div>
              </>
            )}
          </aside>
          </>
        )}
      </div>
      {/* ── 토스트 메시지 ── */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            className="toast-message"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            transition={{ duration: 0.2 }}
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
export default App;





