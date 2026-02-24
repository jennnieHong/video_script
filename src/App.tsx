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

  // ── 구간 감시 인터벌 관리 ──────────────────────────────────
  // playbackMode, start, end 중 하나라도 바뀌면 기존 인터벌을 끄고 새로 시작 (새 클릭 대응)
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (playbackMode === 'none') return;

    intervalRef.current = setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime) return;

      const currentTime = player.getCurrentTime();
      const state = player.getPlayerState?.();
      const s = startRef.current;
      const e = endRef.current;

      // 안전 장치: 시작/종료 시간이 같거나 음수면 체크 건너뜀 (렉 방지)
      if (e <= s || e <= 0.1) return;

      // 구간 종료 감지 (0.1s 여유)
      if (currentTime >= e - 0.1 || state === 0) {
        if (playbackMode === 'loop') {
          player.seekTo(s, true);
          player.playVideo();
        } else if (playbackMode === 'once') {
          player.pauseVideo();
          player.seekTo(e, true); 
          // 1번 재생이 끝나면 이 인터벌을 종료하여 불필요한 체크 방지
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      }
    }, 150);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playbackMode, start, end]); // 의존성 추가: 새 클릭 시 인터벌 리셋

  // ── YT.Player 인스턴스 생성 ───────────────────────────────
  useEffect(() => {
    let destroyed = false;
    const createPlayer = () => {
      if (destroyed || !containerRef.current) return;

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        host: 'https://www.youtube.com',
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
  segment: Segment;      // 매칭된 세그먼트 데이터 (클릭 기준 세그먼트)
  matchIndex: number;    // 오리진 segments[]에서의 인덱스
  loopStartIdx: number;  // 슬라이딩 윈듀우 히트가 시작되는 세그먼트 인덱스
  loopEndIdx: number;    // 슬라이딩 윈듀우 히트가 끝나는 세그먼트 인덱스
}


// ================================================================
// App 컴포넌트 (메인)
// ================================================================
function App() {

  // ─── 상태(State) 정의 ──────────────────────────────────────────

  const [url, setUrl] = useState('');           // 사용자가 입력한 YouTube URL
  const [loading, setLoading] = useState(false); // 백엔드 요청 진행 중 여부 (로딩 스피너 제어)
  const [transcript, setTranscript] = useState(''); // 추출된 전체 자막 텍스트 (평문)
  const [segments, setSegments] = useState<Segment[]>([]); // 타임스탬프별 세그먼트 배열
  const [videoId, setVideoId] = useState('');   // YouTube 영상 ID (URL에서 파싱, 링크 생성에 사용)
  const [error, setError] = useState('');        // 사용자에게 표시할 에러 메시지
  const [copied, setCopied] = useState(false);   // "복사됨" 피드백 표시 여부 (2초 후 자동 리셋)

  const [searchQuery, setSearchQuery] = useState('');    // 실제 검색 실행시 사용되는 쿼리 (만 루지 Enter/버튼시 업데이트)
  const [searchInput, setSearchInput] = useState('');     // 검색 입력창 UI 값 (즉각 반영될 도 를지, 리렌더 범위 최소화)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]); // 검색 결과 목록

  // activeSegIdx: LoopPlayer 재생 중 현재 재생 위치에 해당하는 세그먼트 인덱스
  // -1이면 비활성 (재생 안 함 또는 세그먼트 없음)
  const [activeSegIdx, setActiveSegIdx] = useState<number>(-1);

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
    return {
      start: Math.floor(segments[startSegIdx].start),
      end:   Math.floor(segments[endSegIdx].start + segments[endSegIdx].duration),
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

  const [checkedSegs, setCheckedSegs] = useState<Set<number>>(new Set());
  // checkedSegs: 루프 구간 정의용 체크박스; 연속된 인덱스들이 하나의 loopConfig 구간으로 합산됨

  // ─── 언어 선택 관련 상태 ────────────────────────────────────────
  interface LangOption { code: string; name: string; label: string; is_generated: boolean; }
  const [availableLangs, setAvailableLangs] = useState<LangOption[]>([]); // 조회된 언어 목록
  const [selectedLang, setSelectedLang] = useState('');                   // 사용자가 선택한 언어 코드 ('' = 자동)
  const [langLoading, setLangLoading] = useState(false);                  // 언어 목록 로딩 중 여부
  const [langError, setLangError] = useState('');                         // 언어 조회 실패 메시지
  const [isDragMode, setIsDragMode] = useState(false);                 // 드래그 선택 모드 활성화 여부
  const [isMultiRangeMode, setIsMultiRangeMode] = useState(false);     // 다중 구간 모드 (드래그할 때마다 구간 추가)
  const [multiRanges, setMultiRanges] = useState<{startIdx: number; endIdx: number}[]>([]); // 지정된 구간 목록
  const [rangeGap, setRangeGap] = useState(1);                         // 구간 사이 간격 (초)
  const [activeMultiRangeIdx, setActiveMultiRangeIdx] = useState(0);   // 현재 재생 중인 구간 번호
  const [dragStartIdx, setDragStartIdx] = useState<number | null>(null); // 드래그 시작 세그먼트 인덱스
  // ref: state 업데이트 비동기 지연 없이 드래그 핸들러에서 즉시 읽기 위한 동기 참조
  const dragStartIdxRef   = useRef<number | null>(null); // 드래그 시작 위치
  const dragCurrentIdxRef = useRef<number | null>(null); // 드래그 현재(마지막) 위치
  const [isTrackingMode, setIsTrackingMode] = useState(true);           // 재생 위치 트래킹 모드 (기본값 ON)
  const [trackingOffset, setTrackingOffset] = useState(0.3);             // 트래킹 싱크 오프셋 (초, 기본값 0.3s 빠르게)
  const [timestampPrecision, setTimestampPrecision] = useState(0);       // 타임스탬프 정밀도 (0:초, 1:0.1s, 2:0.01s, 3:ms)
  const [isSeekMode, setIsSeekMode] = useState(false);                  // 선택지점부터 재생 모드 (각 세그먼트에 ▶ 버튼 표시)
  const [showTranslation, setShowTranslation] = useState(false);         // 발음 자막 편집 패널 표시
  const [translations, setTranslations] = useState<Record<number, string>>({}); // 세그먼트별 발음 텍스트
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
    setSearchQuery('');
    setSearchInput('');
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
      setSegments(data.segments || []);        // 타임스탬프 포함 세그먼트 배열
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
    const q = typeof overrideQuery === 'string' ? overrideQuery : searchInput;
    setSearchQuery(q); // 실제 검색 키워드 확정
    if (!q || !q.trim() || segments.length === 0) {
      setSearchResults([]);
      return;
    }

    const query = q.toLowerCase();
    const results: SearchResult[] = [];
    const addedIndices = new Set<number>();

    segments.forEach((segment, index) => {
      if (addedIndices.has(index)) return;

      const prev = segments[index - 1]?.text ?? '';
      const cur  = segment.text;
      const next = segments[index + 1]?.text ?? '';

      // 윈도우 파츠: 공백 없는 세그먼트만 포함
      const parts: { text: string; segIdx: number }[] = [
        { text: prev, segIdx: index - 1 },
        { text: cur,  segIdx: index     },
        { text: next, segIdx: index + 1 },
      ].filter(p => p.text.length > 0);

      const combined = parts.map(p => p.text).join(' ').toLowerCase();
      const hitPos   = combined.indexOf(query);
      if (hitPos === -1) return;

      // 히트 시작/끝 위치가 어느 세그먼트에 속하는지 문자 오프셋으로 계산
      const hitEnd = hitPos + query.length - 1;
      let charOffset   = 0;
      let loopStartIdx = index;
      let loopEndIdx   = index;
      let startFound   = false;

      for (const part of parts) {
        const segEnd     = charOffset + part.text.length - 1;
        charOffset      += part.text.length + 1; // +1: 세그먼트 사이 공백

        const clamped = Math.max(0, Math.min(segments.length - 1, part.segIdx));

        if (!startFound && hitPos <= segEnd) {
          loopStartIdx = clamped;
          startFound   = true;
        }
        if (startFound) {
          loopEndIdx = clamped;
          if (hitEnd <= segEnd) break; // 히트 끝이 이 세그먼트 안에 있으면 종료
        }
      }

      // 히트에 포함된 모든 인덱스를 addedIndices에 등록 (중복 방지)
      for (let si = loopStartIdx; si <= loopEndIdx; si++) addedIndices.add(si);

      results.push({ segment, matchIndex: index, loopStartIdx, loopEndIdx });
    });

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
    if (interactionMode === 'play') {
      // 'loop' 또는 'once' 모드이면 앱 내 플레이어(LoopPlayer) 사용
      if (playbackOption === 'loop' || playbackOption === 'once') {
        const base     = loopRange?.startIdx ?? matchIndex;
        const endIdx   = loopRange?.endIdx   ?? matchIndex;
        const endOffset = Math.max(0, endIdx - base);
        setLoopConfig({ matchIndex: base, startOffset: 0, endOffset });
      } else {
        // 'popup' 모드: 기존처럼 새 창에서 YouTube 열기
        const timeInSeconds = Math.floor(startTime);
        window.open(`https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`, '_blank');
      }
    } else {
      // 'search' 모드: 대본 영역에서 해당 위치로 스크롤 이동
      segmentRefs.current[matchIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 시각적 피드백을 위해 잠시 강조 (activeSegIdx를 활용하거나 별도 상태 가능)
      setActiveSegIdx(matchIndex);
    }
  }, [interactionMode, playbackOption, videoId]);

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
    const next = new Set(checkedSegs);
    if (next.has(idx)) { next.delete(idx); } else { next.add(idx); }

    const groups = findConnectedGroups(next);
    if (groups.length === 0) { setCheckedSegs(new Set()); setLoopConfig(null); return; }

    const focusGroup =
      groups.find(g => g.includes(idx)) ??
      groups.find(g => g[g.length - 1] < idx) ??
      groups[0];

    setCheckedSegs(next);
    setLoopConfig({
      matchIndex: focusGroup[0],
      startOffset: 0,
      endOffset: focusGroup[focusGroup.length - 1] - focusGroup[0],
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [checkedSegs, findConnectedGroups]);

  /** 전체 선택/해제 */
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const all = new Set<number>();
      for (let i = 0; i < segments.length; i++) all.add(i);
      setCheckedSegs(all);
      // 전체 선택 시 첫 번째 세그먼트부터 마지막까지 loopConfig 설정
      if (segments.length > 0) {
        setLoopConfig({ matchIndex: 0, startOffset: 0, endOffset: segments.length - 1 });
      }
    } else {
      setCheckedSegs(new Set());
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
    if (!isDragMode || isSeekMode) return; // 지점 재생 모드일 때는 드래그 무시
    dragStartIdxRef.current   = idx;
    dragCurrentIdxRef.current = idx;
    // state 갱신: 트래킹 인터벌 일시 정지 목적만
    setDragStartIdx(idx);
    // React state 변경 없이 DOM 직접 조작 → 이 리렌더로 renderedSegments 재계산 없음
    applyDragHighlight(idx, idx);
  }, [isDragMode, isSeekMode, applyDragHighlight]);

  const handleDragEnter = useCallback((idx: number) => {
    const startIdx = dragStartIdxRef.current;
    if (!isDragMode || startIdx === null) return;
    // 현재 위치 ref 갱신 → handleDragEnd가 stale closure 없이 마지막 위치를 읽음
    dragCurrentIdxRef.current = idx;
    // setCheckedSegs 대신 DOM 직접 조작 → 드래그 중 리렌더 완전 0회
    applyDragHighlight(startIdx, idx);
  }, [isDragMode, applyDragHighlight]);

  const handleDragEnd = () => {
    const startIdx   = dragStartIdxRef.current;
    const currentIdx = dragCurrentIdxRef.current;
    if (!isDragMode || startIdx === null) return;

    dragStartIdxRef.current   = null;
    dragCurrentIdxRef.current = null;
    setDragStartIdx(null);

    const endIdx     = currentIdx ?? startIdx;
    const rangeStart = Math.min(startIdx, endIdx);
    const rangeEnd   = Math.max(startIdx, endIdx);

    if (isMultiRangeMode) {
      // 이미 동일 구간이 있으면 추가하지 않음
      const isDup = multiRanges.some(r => r.startIdx === rangeStart && r.endIdx === rangeEnd);
      if (!isDup) {
        const isFirst = multiRanges.length === 0;
        setMultiRanges(prev => [...prev, { startIdx: rangeStart, endIdx: rangeEnd }]);

        if (isFirst) {
          // 첫 번째 구간: 플레이어 시작
          setLoopConfig({ matchIndex: rangeStart, startOffset: 0, endOffset: rangeEnd - rangeStart });
          setInteractionMode('play');
          if (playbackOption === 'popup') setPlaybackOption('loop');
        }
        // 이후 구간: setLoopConfig 호출 안 함 → 재생 중단 없음
        // loopConfig는 좌화 사이클링 useEffect가 자동 관리
      }
    } else {
      // 단일 구간 모드: 기존 동작
      setLoopConfig({
        matchIndex:  rangeStart,
        startOffset: 0,
        endOffset:   rangeEnd - rangeStart,
      });
      setInteractionMode('play');
      if (playbackOption === 'popup') setPlaybackOption('loop');
    }
  };

  // loopConfig/multiRanges 변경 시 checkedSegs 동기화
  useEffect(() => {
    // 다중 구간 모드: 모든 구간의 합집합을 체크로 표시
    if (isMultiRangeMode && multiRanges.length > 0) {
      const ns = new Set<number>();
      multiRanges.forEach(r => {
        for (let i = r.startIdx; i <= r.endIdx; i++) ns.add(i);
      });
      setCheckedSegs(ns);
      return;
    }
    // 단일 구간 모드: loopConfig 기준
    if (!loopConfig || segments.length === 0) { setCheckedSegs(new Set()); return; }
    const s = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
    const e = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
    const ns = new Set<number>();
    for (let i = s; i <= e; i++) ns.add(i);
    setCheckedSegs(ns);
  }, [loopConfig, segments, isMultiRangeMode, multiRanges]);

  // ─── 재생 중 활성 세그먼트 감지 → 자동 스크롤 ─────────────────
  // LoopPlayer의 YT.Player 인스턴스에 직접 접근하기 어려우므로,
  // loopSegment가 활성화된 동안 200ms 인터벌로 현재 재생 시간을 폴링하여
  // 해당 시간에 속하는 세그먼트를 찾아 activeSegIdx를 업데이트한다.
  const loopPlayerRef = useRef<any>(null); // LoopPlayer가 공유해주는 YT.Player ref

  useEffect(() => {
    // 트래킹 모드 꺼져 있거나 세그먼트 없으면 종료
    if (!isTrackingMode || segments.length === 0) {
      setActiveSegIdx(-1);
      return;
    }
    // 드래그 중에는 폴링 인터벌 자체를 생성하지 않음
    // → setInterval이 없으면 불필요한 getCurrentTime 호출 및 렌더 방해 없음
    if (dragStartIdx !== null) return;

    const timer = setInterval(() => {
      const player = loopPlayerRef.current;
      if (!player?.getCurrentTime) return;

      // 재생 중(state=1)인지 확인: 정지 상태에서는 스크롤 하지 않음
      const state = player.getPlayerState?.();
      if (state !== 1) return; // 1 = PLAYING

      const t = player.getCurrentTime() + trackingOffset;

      let found = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].start <= t) { found = i; break; }
      }
      if (found !== -1) {
        setActiveSegIdx(found);
        segmentRefs.current[found]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 50);
    return () => clearInterval(timer);
  }, [segments, isTrackingMode, dragStartIdx, trackingOffset]);

  // ─── 다중 구간 순차 재생 ──────────────────────────────────────
  // gapTimerRef / isInGapRef: 구간 간격 대기 상태 관리
  const isInGapRef  = useRef(false);
  // activeMultiRangeIdxRef: interval 콜백이 항상 최신 인덱스를 즉시 읽도록
  const activeMultiRangeIdxRef = useRef(0);
  useEffect(() => { activeMultiRangeIdxRef.current = activeMultiRangeIdx; }, [activeMultiRangeIdx]);

  useEffect(() => {
    // 다중 구간 모드 + 구간 2개 이상 + loopMode만 처리
    if (!isMultiRangeMode || multiRanges.length < 2 || !loopMode) return;
    if (dragStartIdx !== null) return;

    let cancelled = false; // 이 effect 인스턴스가 cleanup됐는지 여부

    const timer = setInterval(() => {
      if (isInGapRef.current) return;
      const player = loopPlayerRef.current;
      if (!player?.getCurrentTime) return;

      const state     = player.getPlayerState?.();
      const t         = player.getCurrentTime();
      const curIdx    = activeMultiRangeIdxRef.current; // ref로 즉시 읽기
      const cur       = multiRanges[curIdx];
      if (!cur || !segments[cur.endIdx]) return;

      const endTime    = segments[cur.endIdx].start + segments[cur.endIdx].duration;
      // 재생이 구간 끝에 도달했거나 영상이 자연 종료된 경우
      const rangeEnded = (state === 1 && t >= endTime - 0.15) || state === 0;
      if (!rangeEnded) return;

      isInGapRef.current = true;
      if (state !== 0) player.pauseVideo(); // 아직 재생 중이면 정지

      const nextIdx   = (curIdx + 1) % multiRanges.length;
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

  // ─── 검색어 키워드 하이라이트 헬퍼 ───────────────────────────
  // text를 query 기준으로 분리하여 <mark>로 감싼 React 노드 배열로 반환
  const highlightText = useCallback((text: string, query: string): React.ReactNode => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="search-highlight">{part}</mark>
        : part
    );
  }, []);

  // ─── 대본 렌더링 메모이제이션 ───────────────────────────
  // useMemo를 상위 레벨로 이동하여 Hook 규칙 준수 및 타이핑 지연 해결
  const renderedSegments = useMemo(() => {
    if (segments.length === 0) return <p className="transcript-text">{transcript}</p>;
    return (
      <div className="transcript-segments">
        {segments.map((seg, i) => {
          const isActive  = activeSegIdx === i;
          const isHit     = searchResults.some(r => r.matchIndex === i);
          return (
            <div
              key={i}
              ref={el => { segmentRefs.current[i] = el; }}
              className={[
                'transcript-seg',
                isActive               ? 'active'   : '',
                isHit                  ? 'hit'      : '',
                checkedSegs.has(i)     ? 'checked'  : '',
                isDragMode             ? 'drag-mode': '',
                isSeekMode             ? 'seek-mode': '',
              ].join(' ').trim()}
              onMouseDown={() => { if (!isSeekMode) handleDragStart(i); }}
              onMouseEnter={() => { if (!isSeekMode) handleDragEnter(i); }}
              onClick={isSeekMode ? () => {
                // 드래그 구간 해제 → 자유 재생
                setLoopConfig(null);
                const player = loopPlayerRef.current;
                if (player?.seekTo) {
                  player.seekTo(seg.start, true);
                  player.playVideo();
                }
              } : undefined}
              title={isSeekMode ? `${formatTimestamp(seg.start)}부터 재생` : undefined}
            >
              {/* 체크박스 토글 (구간반복 모드에서만 활성화) */}
              {loopMode && (
                <button
                  className={`seg-check${checkedSegs.has(i) ? ' seg-check--on' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleSegToggle(i); }}
                  title={checkedSegs.has(i) ? '구간에서 제외' : '이 세그먼트를 연속 구간에 포함'}
                />
              )}
              {/* 타임스탬프 버튼 */}
              <button
                className="seg-timestamp"
                onClick={(e) => { if (isSeekMode) e.stopPropagation(); openYouTubeAtTime(i, seg.start); }}
                title={loopMode ? '클릭 → 이 세그먼트 재생' : '클릭 → YouTube에서 열기'}
              >
                {formatTimestamp(seg.start)}
              </button>
              {/* 텍스트 (검색 키워드 하이라이트) */}
              <span className="seg-text">
                {highlightText(seg.text.trim(), searchQuery && searchResults.length > 0 ? searchQuery : '')}
              </span>
              {/* 발음 자막 입력 */}
              {showTranslation && (
                <input
                  className="seg-translation"
                  type="text"
                  placeholder="발음 입력..."
                  value={translations[i] || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTranslations(prev => ({ ...prev, [i]: val }));
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }, [segments, activeSegIdx, searchResults, checkedSegs, isDragMode, isSeekMode, loopMode, searchQuery, transcript, showTranslation, translations, handleDragStart, handleDragEnter, handleSegToggle, openYouTubeAtTime, formatTimestamp, highlightText]);

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
      <div className={`main-content${hasResult ? '' : ' hero-layout'}`}>

        {/* ══ 좌측 패널: 입력 & 컨트롤 ══════════════════════════ */}
        <aside className="left-panel">

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
                  type="text"
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


          {/* ── 검색 패널 (결과 있을 때만) ── */}
          {hasResult && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="controls-block search-panel"
            >
              <p className="section-label">
                <Search style={{ width: 11, height: 11 }} />
                대사 검색
              </p>

              <div className="search-field">
                <Search style={{ width: 13, height: 13, color: 'var(--text-muted)', flexShrink: 0 }} />
                <input
                  type="text"
                  placeholder="키워드 검색..."
                  value={searchInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSearchInput(v);
                    // 입력이 비어지면 즉시 결과 초기화
                    if (!v.trim()) {
                      setSearchQuery('');
                      setSearchResults([]);
                    }
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button className="btn-search" onClick={() => handleSearch()}>
                  <Search style={{ width: 11, height: 11 }} /> 검색
                </button>
              </div>

              {/* 클릭 동작 설정 (검색 vs 재생) */}
              <div className="mode-selector-wrap">
                <div className="mode-tabs">
                  <button
                    className={`mode-tab ${interactionMode === 'search' ? 'active' : ''}`}
                    onClick={() => setInteractionMode('search')}
                  >
                    <Search style={{ width: 12, height: 12 }} /> 검색 모드
                  </button>
                  <button
                    className={`mode-tab ${interactionMode === 'play' ? 'active' : ''}`}
                    onClick={() => setInteractionMode('play')}
                  >
                    <Youtube style={{ width: 12, height: 12 }} /> 재생 모드
                  </button>
                </div>

                <AnimatePresence>
                  {interactionMode === 'play' && (
                    <motion.div
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="playback-options"
                    >
                      <label className="play-opt">
                        <input
                          type="radio"
                          name="play-type"
                          checked={playbackOption === 'loop'}
                          onChange={() => setPlaybackOption('loop')}
                        />
                        <span className="play-opt-box">
                          <RotateCcw style={{ width: 11, height: 11, animation: 'spin 3s linear infinite' }} /> 반복 재생
                        </span>
                      </label>
                      <label className="play-opt">
                        <input
                          type="radio"
                          name="play-type"
                          checked={playbackOption === 'once'}
                          onChange={() => setPlaybackOption('once')}
                        />
                        <span className="play-opt-box">
                          <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          1번 재생
                        </span>
                      </label>
                      <label className="play-opt">
                        <input
                          type="radio"
                          name="play-type"
                          checked={playbackOption === 'popup'}
                          onChange={() => setPlaybackOption('popup')}
                        />
                        <span className="play-opt-box">
                          <svg style={{ width: 11, height: 11 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          새 창 팝업
                        </span>
                      </label>
                    </motion.div>
                  )}
                  {interactionMode === 'search' && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="mode-hint"
                    >
                      결과 클릭 시 대본의 해당 위치로 이동합니다.
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* 검색 결과 목록 — flex:1 영역 */}
              <div className="search-panel-results">
                <AnimatePresence mode="sync">
                  {searchResults.length > 0 && (
                    <motion.div
                      key="search-results"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
                    >
                      <div style={{
                        padding: '0.3rem 0',
                        fontSize: '0.7rem', color: 'var(--text-muted)',
                        borderTop: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: '0.3rem',
                        flexShrink: 0,
                      }}>
                        <Clock style={{ width: 11, height: 11 }} />
                        {searchResults.length}개 결과
                      </div>
                      <div className="search-results-panel">
                        {searchResults.map((result, idx) => (
                          <motion.div
                            key={`${result.matchIndex}-${idx}`}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: Math.min(idx * 0.03, 0.2) }}
                            onClick={() => openYouTubeAtTime(
                              result.matchIndex,
                              result.segment.start,
                              { startIdx: result.loopStartIdx, endIdx: result.loopEndIdx },
                            )}
                            className={`search-result-item${
                              loopMode && loopConfig &&
                              loopConfig.matchIndex >= result.loopStartIdx &&
                              loopConfig.matchIndex + loopConfig.endOffset <= result.loopEndIdx
                                ? ' playing' : ''
                            }`}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1, minWidth: 0 }}>
                              <span className="timestamp-badge">{formatTimestamp(result.segment.start)}</span>
                              <p className="search-result-text">
                                {highlightText(result.segment.text, searchQuery)}
                              </p>
                            </div>
                            <button
                              className="btn-result-loop"
                              title="이 구간 즉시 반복 재생"
                              onClick={(e) => {
                                e.stopPropagation(); // 부모의 onClick(검색 모드 이동) 방지
                                // 강제로 반복 재생 설정
                                const base = result.loopStartIdx;
                                const endOffset = Math.max(0, result.loopEndIdx - base);
                                setLoopConfig({ matchIndex: base, startOffset: 0, endOffset });
                                setInteractionMode('play');
                                if (playbackOption === 'popup') {
                                  setPlaybackOption('loop');
                                }
                              }}
                            >
                              <RotateCcw style={{ width: 12, height: 12 }} />
                            </button>
                            <button
                              className="btn-result-loop"
                              title={`${formatTimestamp(result.segment.start)}부터 재생`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const player = loopPlayerRef.current;
                                if (player?.seekTo) {
                                  player.seekTo(result.segment.start, true);
                                  player.playVideo();
                                }
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            </button>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                  {searchQuery && searchResults.length === 0 && segments.length > 0 && (
                    <motion.div
                      key="no-result"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      style={{ padding: '0.5rem 0', fontSize: '0.775rem', color: 'var(--warning)', borderTop: '1px solid var(--border)' }}
                    >
                      "{searchQuery}" 검색 결과가 없습니다.
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}

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
                    setMultiRanges([{ startIdx: s, endIdx: e }]);
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
                        setMultiRanges([{ startIdx: s, endIdx: en }]);
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
                      ) : (
                        <div className="multi-range-list">
                          {multiRanges.map((r, ri) => {
                            const sSeg = segments[r.startIdx];
                            const eSeg = segments[r.endIdx];
                            if (!sSeg) return null;
                            const isPlaying = activeMultiRangeIdx === ri && loopMode;
                            return (
                              <div key={ri} className={`multi-range-item${isPlaying ? ' playing' : ''}`}>
                                <span className="multi-range-num">{ri + 1}</span>
                                <span className="multi-range-time">
                                  {formatTimestamp(sSeg.start)} ~ {formatTimestamp(eSeg.start + eSeg.duration)}
                                </span>
                                <button className="multi-range-del" title="삭제"
                                  onClick={() => { setMultiRanges(prev => prev.filter((_, i) => i !== ri)); setActiveMultiRangeIdx(0); }}>✕</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
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
                          onClick={() => { setMultiRanges([]); setActiveMultiRangeIdx(0); }}
                        >구간 전체 삭제</button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </aside>

        {/* ══ 우측 패널: 결과 ════════════════════════════════════ */}
        <main className="right-panel">

          {/* 로딩 */}
          {loading && (
            <div className="loading-state">
              <div className="spinner-ring" />
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280, margin: 0 }}>
                AI가 영상을 분석하고 있습니다.<br />
                <span style={{ color: 'var(--text-secondary)' }}>영상 길이에 따라 수 분이 소요될 수 있습니다.</span>
              </p>
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
              <div className="video-and-controls">
                {videoId && (
                  <div className="video-section">
                    <LoopPlayer
                      key={`player-${videoId}`}
                      videoId={videoId}
                      start={loopSegment?.start ?? 0}
                      end={loopSegment?.end ?? 0}
                      playbackMode={
                        !loopMode ? 'none' :
                        // 다중 구간 모드(2개 이상): LoopPlayer 자체 루프 비활성
                        // → App의 사이클링 useEffect가 구간 전환을 전담
                        // (LoopPlayer 루프가 살아있으면 seekTo 충돌로 A만 반복되는 버그)
                        (isMultiRangeMode && multiRanges.length >= 2) ? 'none' :
                        (playbackOption === 'once' ? 'once' : 'loop')
                      }
                      onClose={() => setLoopConfig(null)}
                      formatTimestamp={formatTimestamp}
                      onPlayerReady={(player) => { loopPlayerRef.current = player; }}
                    />
                  </div>
                )}
                
                <AnimatePresence>
                  {loopMode && loopConfig && loopSegment && (
                    <motion.div 
                      key="loop-controls"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      style={{ overflow: 'hidden' }}
                      className="loop-controls-panel"
                    >
                      <div className="loop-controls">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--brand-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            구간 실시간 조정
                          </span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                            {formatTimestamp(loopSegment.start)} ~ {formatTimestamp(loopSegment.end)}
                            &nbsp;({Math.floor(loopSegment.end - loopSegment.start)}s)
                          </span>
                        </div>
                        <div className="loop-ctrl-row" style={{ marginBottom: '0.375rem' }}>
                          <span className="loop-ctrl-label">시작</span>
                          <button className="btn-loop-step"
                            onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.min(c.startOffset + 1, c.matchIndex) } : null)}
                            disabled={loopSegment.startSegIdx === 0}
                          >◀</button>
                          <div className="loop-ctrl-preview">
                            <span className="loop-ctrl-time">{formatTimestamp(loopSegment.startSeg.start)}</span>
                            <span className="loop-ctrl-text">{loopSegment.startSeg.text.trim()}</span>
                          </div>
                          <button className="btn-loop-step"
                            onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.max(0, c.startOffset - 1) } : null)}
                            disabled={loopConfig.startOffset === 0}
                          >▶</button>
                        </div>
                        <div className="loop-ctrl-row">
                          <span className="loop-ctrl-label">종료</span>
                          <button className="btn-loop-step"
                            onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.max(0, c.endOffset - 1) } : null)}
                            disabled={loopConfig.endOffset === 0}
                          >◀</button>
                          <div className="loop-ctrl-preview">
                            <span className="loop-ctrl-time">{formatTimestamp(loopSegment.endSeg.start + loopSegment.endSeg.duration)}</span>
                            <span className="loop-ctrl-text">{loopSegment.endSeg.text.trim()}</span>
                          </div>
                          <button className="btn-loop-step"
                            onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.min(c.endOffset + 1, segments.length - 1 - c.matchIndex) } : null)}
                            disabled={loopSegment.endSegIdx >= segments.length - 1}
                          >▶</button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* 액션 바 */}
              <div className="action-bar">
                <span className="action-bar-title">
                  <FileText style={{ width: 14, height: 14, color: 'var(--brand-light)' }} />
                  추출된 대사
                  {segments.length > 0 && (
                    <span style={{
                      fontSize: '0.7rem', padding: '0.15rem 0.5rem',
                      background: 'var(--surface-2)', border: '1px solid var(--border)',
                      borderRadius: 100, color: 'var(--text-muted)', fontWeight: 500
                    }}>{segments.length}개</span>
                  )}
                </span>
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
                className="transcript-scroll" 
                onMouseUp={handleDragEnd}
                onMouseLeave={handleDragEnd}
              >
                {renderedSegments}
              </div>

              {/* 대본 하단 설정 바 */}
              <div className="transcript-footer">
                <div className="footer-controls">
                  {/* 선택지점부터 재생 모드 */}
                  <div className={`mode-toggle-bar ${isSeekMode ? 'active' : ''}`} onClick={() => { const next = !isSeekMode; setIsSeekMode(next); if (next) setLoopConfig(null); }}>
                    <div className="mode-toggle-info">
                      <span className="mode-toggle-icon">
                        <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      </span>
                      <div className="mode-toggle-texts">
                        <span className="mode-toggle-title">지점 재생</span>
                        <span className="mode-toggle-desc">해당 위치부터 재생</span>
                      </div>
                    </div>
                    <div className="toggle">
                      <input
                        type="checkbox"
                        checked={isSeekMode}
                        onChange={(e) => { e.stopPropagation(); const next = e.target.checked; setIsSeekMode(next); if (next) setLoopConfig(null); }}
                      />
                      <div className="toggle-track" />
                      <div className="toggle-thumb" />
                    </div>
                  </div>

                  {/* 드래그 선택 모드 */}
                  <div className={`mode-toggle-bar ${isDragMode ? 'active' : ''}`} onClick={() => setIsDragMode(v => !v)}>
                    <div className="mode-toggle-info">
                      <span className="mode-toggle-icon">
                        <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-2 2-2-2"/><path d="M15 6l-2-2-2 2"/><path d="M18 15l2-2-2-2"/><path d="M6 15l-2-2 2-2"/></svg>
                      </span>
                      <div className="mode-toggle-texts">
                        <span className="mode-toggle-title">드래그 영역 재생</span>
                        <span className="mode-toggle-desc">구간 직접 지정</span>
                      </div>
                    </div>
                    <div className="toggle">
                      <input
                        type="checkbox"
                        checked={isDragMode}
                        onChange={(e) => { e.stopPropagation(); setIsDragMode(e.target.checked); }}
                      />
                      <div className="toggle-track" />
                      <div className="toggle-thumb" />
                    </div>
                  </div>

                  {/* 재생 위치 트래킹 */}
                  <div className={`mode-toggle-bar ${isTrackingMode ? 'active' : ''}`} onClick={() => setIsTrackingMode(v => !v)}>
                    <div className="mode-toggle-info">
                      <span className="mode-toggle-icon">
                        <Clock style={{ width: 14, height: 14 }} />
                      </span>
                      <div className="mode-toggle-texts">
                        <span className="mode-toggle-title">위치 트래킹</span>
                        <span className="mode-toggle-desc">재생 시 자동 스크롤</span>
                      </div>
                    </div>
                    <div className="toggle">
                      <input
                        type="checkbox"
                        checked={isTrackingMode}
                        onChange={(e) => { e.stopPropagation(); setIsTrackingMode(e.target.checked); }}
                      />
                      <div className="toggle-track" />
                      <div className="toggle-thumb" />
                    </div>
                  </div>
                </div>

                {/* 싱크 미세 조정 (트래킹 모드 시에만 표시) */}
                <AnimatePresence>
                  {isTrackingMode && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="sync-adjust-bar"
                    >
                      <div className="sync-info">
                        <RotateCcw style={{ width: 12, height: 12, color: 'var(--brand-light)' }} />
                        <span className="sync-label">싱크 조정</span>
                        <span className="sync-value">
                          {trackingOffset > 0 ? `+${trackingOffset.toFixed(1)}s` : `${trackingOffset.toFixed(1)}s`}
                          <span className="sync-hint">({trackingOffset > 0 ? '빨리' : '느리게'})</span>
                        </span>
                      </div>
                      <div className="sync-controls">
                        <button className="sync-btn" onClick={() => setTrackingOffset(prev => prev - 0.1)} title="0.1초 늦게">-</button>
                        <input 
                          type="range" min="-3" max="3" step="0.1" 
                          value={trackingOffset} 
                          onChange={(e) => setTrackingOffset(parseFloat(e.target.value))}
                          className="sync-slider"
                        />
                        <button className="sync-btn" onClick={() => setTrackingOffset(prev => prev + 0.1)} title="0.1초 빨리">+</button>
                        <button className="sync-reset" onClick={() => setTrackingOffset(0.3)}>초기화</button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
