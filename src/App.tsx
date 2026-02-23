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

import { useState, useRef, useEffect } from 'react';
// lucide-react: 아이콘 라이브러리
import { Youtube, Send, Copy, Download, Loader2, FileText, CheckCircle2, Search, Clock, RotateCcw } from 'lucide-react';
// framer-motion: 애니메이션(페이드인, 슬라이드 등)
import { motion, AnimatePresence } from 'framer-motion';
// axios: HTTP 클라이언트 (백엔드 API 호출)
import axios from 'axios';

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
}: {
  videoId: string;
  start: number;
  end: number;
  onClose: () => void;
  formatTimestamp: (s: number) => string;
  onPlayerReady?: (player: any) => void;
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
    startRef.current = start;
    endRef.current = end;

    // 현재 재생 위치가 새 구간 밖으로 벗어났으면 start로 즉시 점프
    // (구간을 줄여서 현재 위치가 새 end를 넘었거나, start보다 앞인 경우)
    const player = playerRef.current;
    if (player?.getCurrentTime) {
      const t = player.getCurrentTime();
      if (t < start || t >= end) {
        player.seekTo(start, true);
        player.playVideo();
      }
      // 현재 위치가 새 구간 안에 있으면 그대로 재생 유지 (끊기지 않음)
    }
  }, [start, end]);

  // 플레이어 생성은 videoId가 처음 마운트될 때 한 번만 (start/end 변경 시에는 재생성 안 함)
  useEffect(() => {
    let destroyed = false;

    // ── 구간 감시 인터벌 시작 ──────────────────────────────────
    // ref를 통해 항상 최신 start/end를 읽으므로 실시간 구간 조정이 즉시 반영됨
    const startInterval = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        const player = playerRef.current;
        if (!player?.getCurrentTime) return;

        const currentTime = player.getCurrentTime();
        const state = player.getPlayerState?.();
        // YT.PlayerState 상수:
        //   -1 = 시작안됨, 0 = 종료, 1 = 재생 중, 2 = 일시정지, 3 = 버퍼링, 5 = 큐됨

        // ref에서 최신 start/end 읽기 (클로저 캡처 문제 없음)
        const s = startRef.current;
        const e = endRef.current;

        // 구간 종료 조건:
        //   (1) 현재 시간이 end 이상 → 구간 끝, start로 되돌림
        //   (2) 영상이 자연 종료됨 (state=0)
        //   (3) 일시정지 상태이고 end에 근접 (playerVars.end 없이 interval로만 제어하는 경우)
        if (currentTime >= e || state === 0 || (state === 2 && currentTime >= e - 0.5)) {
          player.seekTo(s, true); // 항상 최신 start ref로 이동 (true = preciseSeeking)
          player.playVideo();
        }
      }, 150); // 150ms마다 체크 (너무 짧으면 과부하, 너무 길면 부정확)
    };

    // ── YT.Player 인스턴스 생성 ───────────────────────────────
    const createPlayer = () => {
      if (destroyed || !containerRef.current) return;

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          start: startRef.current, // 초기 재생 시작 위치 (이후 변경은 ref+interval 처리)
          autoplay: 1,
          controls: 1,
          // end를 playerVars에 넣지 않음 → state=2(pause) 문제를 피하고 interval로만 제어
        },
        events: {
          onReady: (e: any) => {
            e.target.seekTo(startRef.current, true);
            e.target.playVideo();
            startInterval();
            onPlayerReady?.(e.target); // App으로 YT.Player 인스턴스 공유
          },
          onStateChange: (e: any) => {
            // 영상이 자연 종료(state=0)된 경우에도 즉시 start로 되돌려 재생
            if (e.data === 0) {
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
      {/* 상단 상태 표시줄: 현재 반복 구간과 닫기 버튼 */}
      <div className="loop-player-bar">
        <span className="loop-player-label">
          <RotateCcw style={{ width: 13, height: 13, animation: 'spin 2s linear infinite', flexShrink: 0 }} />
          구간 반복 중: {formatTimestamp(start)} ~ {formatTimestamp(end)}
        </span>
        <button className="loop-player-close" onClick={onClose}>✕ 닫기</button>
      </div>
      {/* YouTube IFrame API가 이 div 요소를 실제 <iframe>으로 교체 */}
      <div ref={containerRef} className="loop-player-frame" />
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

  const [searchQuery, setSearchQuery] = useState('');           // 검색창 입력값
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

  // playbackOption: 'play' 모드일 때 재생 방식 ('loop' | 'popup')
  // - 'loop': 앱 내 플레이어로 구간 반복
  // - 'popup': 새 창에서 해당 시간대 열기
  const [playbackOption, setPlaybackOption] = useState<'loop' | 'popup'>('loop');

  // loopMode: 기존 boolean 하위 호환 및 UI 상태 관리를 위해 interactionMode === 'play' && playbackOption === 'loop' 인 경우로 계산
  const loopMode = interactionMode === 'play' && playbackOption === 'loop';

  // loopConfig: 구간반복 모드에서 현재 재생 중인 구간 설정
  //   - 클릭 즉시 설정되어 LoopPlayer가 바로 시작됨
  //   - 재생 중에 startOffset/endOffset을 조정하면 실시간으로 start/end가 갱신됨
  //   - null이면 플레이어 표시 안 함
  const [loopConfig, setLoopConfig] = useState<{
    matchIndex: number;  // 기준 세그먼트의 segments[] 인덱스 (검색 결과 클릭 시 설정)
    startOffset: number; // 시작을 matchIndex 기준으로 몇 세그먼트 앞으로 당길지 (0 = 클릭한 세그먼트)
    endOffset: number;   // 종료를 matchIndex 기준으로 몇 세그먼트 뒤로 늘릴지 (0 = 클릭한 세그먼트)
  } | null>(null);

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
  const formatTimestamp = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      // 1시간 이상: "H:MM:SS" 형식
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    // 1시간 미만: "M:SS" 형식
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  // ─── 자막 내 키워드 검색 ──────────────────────────────────────
  /**
   * handleSearch
   *   - searchQuery를 소문자 변환 후 segments 배열 전체를 순회
   *   - text에 해당 문자열이 포함된 세그먼트를 SearchResult로 수집
   *   - 결과가 없으면 searchResults를 빈 배열로 초기화 (UI에서 "없음" 메시지 표시)
   */
  const handleSearch = () => {
    if (!searchQuery.trim() || segments.length === 0) {
      setSearchResults([]);
      return;
    }

    const query = searchQuery.toLowerCase();
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
  const openYouTubeAtTime = (
    matchIndex: number,
    startTime:  number,
    loopRange?: { startIdx: number; endIdx: number },
  ) => {
    if (interactionMode === 'play') {
      if (playbackOption === 'loop') {
        const base     = loopRange?.startIdx ?? matchIndex;
        const endIdx   = loopRange?.endIdx   ?? matchIndex;
        const endOffset = Math.max(0, endIdx - base);
        setLoopConfig({ matchIndex: base, startOffset: 0, endOffset });
        // 플레이어가 있는 상단으로 스크롤하지 않고 대본 위치 유지 (사용자 편의)
      } else {
        const timeInSeconds = Math.floor(startTime);
        window.open(`https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`, '_blank');
      }
    } else {
      // 'search' 모드: 대본 영역에서 해당 위치로 스크롤 이동
      segmentRefs.current[matchIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 시각적 피드백을 위해 잠시 강조 (activeSegIdx를 활용하거나 별도 상태 가능)
      setActiveSegIdx(matchIndex);
    }
  };

  // ─── 세그먼트 체크박스 ───────────────────────────────────────────
  /** 체크된 세그먼트 셋에서 연속된 그룹 배열 생성. ex) {1,2,3,7,8} → [[1,2,3],[7,8]] */
  const findConnectedGroups = (segs: Set<number>): number[][] => {
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
  };

  /** 세그먼트 체크박스 토글: 연속 그룹을 찾아 loopConfig 자동 갱신 */
  const handleSegToggle = (idx: number) => {
    if (!loopMode) return;
    const next = new Set(checkedSegs);
    if (next.has(idx)) { next.delete(idx); } else { next.add(idx); }

    const groups = findConnectedGroups(next);
    if (groups.length === 0) { setCheckedSegs(new Set()); setLoopConfig(null); return; }

    // 토글된 idx를 포함하는 그룹 우선 → 없으면 인접 앞 그룹 → 첫 그룹
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
  };

  // loopConfig 변경 시 checkedSegs 동기화 (수동 ±, 검색 클릭 등 외부 변경도 반영)
  useEffect(() => {
    if (!loopConfig || segments.length === 0) { setCheckedSegs(new Set()); return; }
    const s = Math.max(0, loopConfig.matchIndex - loopConfig.startOffset);
    const e = Math.min(segments.length - 1, loopConfig.matchIndex + loopConfig.endOffset);
    const ns = new Set<number>();
    for (let i = s; i <= e; i++) ns.add(i);
    setCheckedSegs(ns);
  }, [loopConfig, segments]);

  // ─── 재생 중 활성 세그먼트 감지 → 자동 스크롤 ─────────────────
  // LoopPlayer의 YT.Player 인스턴스에 직접 접근하기 어려우므로,
  // loopSegment가 활성화된 동안 200ms 인터벌로 현재 재생 시간을 폴링하여
  // 해당 시간에 속하는 세그먼트를 찾아 activeSegIdx를 업데이트한다.
  const loopPlayerRef = useRef<any>(null); // LoopPlayer가 공유해주는 YT.Player ref

  useEffect(() => {
    if (!loopMode || !loopConfig || segments.length === 0) {
      setActiveSegIdx(-1);
      return;
    }
    const timer = setInterval(() => {
      const player = loopPlayerRef.current;
      if (!player?.getCurrentTime) return;
      const t = player.getCurrentTime();
      // 현재 재생 시간 t가 속하는 세그먼트를 역방향으로 탐색 (마지막 start <= t)
      let found = -1;
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].start <= t) { found = i; break; }
      }
      if (found !== -1) {
        setActiveSegIdx(prev => {
          if (prev !== found) {
            // 새 활성 세그먼트가 보이도록 스크롤
            segmentRefs.current[found]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          return found;
        });
      }
    }, 200);
    return () => clearInterval(timer);
  }, [loopMode, loopConfig, segments]);

  // ─── 검색어 키워드 하이라이트 헬퍼 ───────────────────────────
  // text를 query 기준으로 분리하여 <mark>로 감싼 React 노드 배열로 반환
  const highlightText = (text: string, query: string): React.ReactNode => {
    if (!query.trim()) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="search-highlight">{part}</mark>
        : part
    );
  };

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

          {/* 결과 있을 때 — 설정 컨트롤 */}
          {hasResult && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="controls-block"
            >
              <p className="section-label">저장 옵션</p>

              {/* 타임스탬프 토글 */}
              <label className="control-row" style={{ cursor: 'pointer' }}>
                <span className="control-row-label">
                  <Clock style={{ width: 14, height: 14, color: 'var(--brand-light)' }} />
                  타임스탬프 포함 저장
                </span>
                <div className="toggle">
                  <input
                    type="checkbox"
                    checked={includeTimestamps}
                    onChange={() => setIncludeTimestamps(v => !v)}
                  />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </div>
              </label>

              {/* 줄바꿈 토글 */}
              <label className="control-row" style={{ cursor: 'pointer' }}>
                <span className="control-row-label">
                  <svg style={{ width: 14, height: 14, color: lineBreak ? 'var(--brand-light)' : 'var(--text-muted)', flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  줄바꿈
                </span>
                <div className="toggle">
                  <input
                    type="checkbox"
                    checked={lineBreak}
                    onChange={() => setLineBreak(v => !v)}
                  />
                  <div className="toggle-track" />
                  <div className="toggle-thumb" />
                </div>
              </label>

              {/* 빈 줄 수 선택 (줄바꿈 ON 또는 타임스탬프 ON일 때 표시) */}
              <AnimatePresence>
                {(lineBreak || includeTimestamps) && (
                  <motion.div
                    key="line-break-count"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div className="control-row" style={{ alignItems: 'center' }}>
                      <span className="control-row-label" style={{ fontSize: '0.775rem' }}>
                        세그먼트 사이 빈 줄
                      </span>
                      {/* 빈 줄 수 버튼 그룹: 0 / 1 / 2 / 3줄 */}
                      <div style={{ display: 'flex', gap: '0.25rem' }}>
                        {[0, 1, 2, 3].map(n => (
                          <button
                            key={n}
                            onClick={() => setLineBreakCount(n)}
                            style={{
                              width: 28, height: 26,
                              borderRadius: 6,
                              border: lineBreakCount === n
                                ? '1px solid var(--brand)'
                                : '1px solid var(--border-strong)',
                              background: lineBreakCount === n
                                ? 'rgba(99,102,241,0.2)'
                                : 'var(--surface-2)',
                              color: lineBreakCount === n
                                ? 'var(--brand-light)'
                                : 'var(--text-muted)',
                              fontSize: '0.725rem',
                              fontWeight: lineBreakCount === n ? 700 : 400,
                              cursor: 'pointer',
                              transition: 'all 0.15s',
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


              {segments.length > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.5rem 0.875rem',
                  fontSize: '0.75rem', color: 'var(--text-muted)'
                }}>
                  <span>추출된 세그먼트</span>
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{segments.length}개</span>
                </div>
              )}
            </motion.div>
          )}

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
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button className="btn-search" onClick={handleSearch}>
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
                                setPlaybackOption('loop');
                              }}
                            >
                              <RotateCcw style={{ width: 12, height: 12 }} />
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
              {/* 구간반복 플레이어 */}
              {loopMode && loopConfig && loopSegment && (
                <div>
                  <LoopPlayer
                    videoId={videoId}
                    start={loopSegment.start}
                    end={loopSegment.end}
                    onClose={() => setLoopConfig(null)}
                    formatTimestamp={formatTimestamp}
                    onPlayerReady={(player) => { loopPlayerRef.current = player; }}
                  />
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
                </div>
              )}

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
                <button className="btn-icon" onClick={downloadTxt} title="TXT 파일로 저장">
                  <Download style={{ width: 13, height: 13 }} />
                  {includeTimestamps ? '저장 (타임스탬프)' : '저장'}
                </button>
              </div>

              {/* 자막 — 세그먼트별 렌더링 (하이라이트 + 재생 위치 추적) */}
              <div className="transcript-scroll">
                {segments.length > 0 ? (
                  <div className="transcript-segments">
                    {segments.map((seg, i) => {
                      const isActive  = activeSegIdx === i;   // 현재 재생 중인 세그먼트
                      const isHit     = searchResults.some(r => r.matchIndex === i); // 검색 히트
                      return (
                        <div
                          key={i}
                          ref={el => { segmentRefs.current[i] = el; }}
                          className={[
                            'transcript-seg',
                            isActive               ? 'active'  : '',
                            isHit                  ? 'hit'     : '',
                            checkedSegs.has(i)     ? 'checked' : '',
                          ].join(' ').trim()}
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
                            onClick={() => openYouTubeAtTime(i, seg.start)}
                            title={loopMode ? '클릭 → 이 세그먼트는자 재생' : '클릭 → YouTube에서 열기'}
                          >
                            {formatTimestamp(seg.start)}
                          </button>
                          {/* 텍스트 (검색 키워드 하이라이트) */}
                          <span className="seg-text">
                            {highlightText(seg.text.trim(), searchQuery && searchResults.length > 0 ? searchQuery : '')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // 세그먼트 없음 (레거시 평문 transcript)
                  <p className="transcript-text">{transcript}</p>
                )}
              </div>

            </motion.div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
