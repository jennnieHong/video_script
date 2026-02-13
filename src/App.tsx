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
}: {
  videoId: string;
  start: number;
  end: number;
  onClose: () => void;
  formatTimestamp: (s: number) => string;
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
    <div className="mb-4 rounded-xl overflow-hidden border border-indigo-500/30 bg-black">
      {/* 상단 상태 표시줄: 현재 반복 구간과 닫기 버튼 */}
      <div className="flex items-center justify-between px-3 py-2 bg-indigo-600/20">
        <span className="text-xs text-indigo-300 flex items-center gap-1.5">
          <RotateCcw className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '2s' }} />
          구간 반복 중: {formatTimestamp(start)} ~ {formatTimestamp(end)}
        </span>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          ✕ 닫기
        </button>
      </div>
      {/* YouTube IFrame API가 이 div 요소를 실제 <iframe>으로 교체 */}
      <div ref={containerRef} className="w-full aspect-video" />
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
  segment: Segment; // 매칭된 세그먼트 데이터
  matchIndex: number; // 원본 segments 배열에서의 인덱스 (추후 활용 가능)
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

  const [loopMode, setLoopMode] = useState(false); // 구간반복 모드 ON/OFF

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

  const [pendingUrl, setPendingUrl] = useState('');
  // pendingUrl: Whisper 확인 모달이 뜬 동안 임시 저장된 요청 URL

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
      setSearchResults([]); // 빈 쿼리나 세그먼트 없으면 결과 초기화
      return;
    }

    const query = searchQuery.toLowerCase(); // 대소문자 무시 비교
    const results: SearchResult[] = [];

    segments.forEach((segment, index) => {
      if (segment.text.toLowerCase().includes(query)) {
        results.push({ segment, matchIndex: index });
      }
    });

    setSearchResults(results);
  };

  /**
   * openYouTubeAtTime
   *   - 구간반복 모드 OFF: 해당 시간부터 YouTube를 새 탭에서 열기
   *   - 구간반복 모드 ON : 즉시 LoopPlayer를 시작하고, 재생 중에 구간을 실시간 조정
   *
   * @param matchIndex 클릭한 세그먼트의 segments 배열 인덱스
   * @param startTime  클릭한 세그먼트의 시작 시간 (일반 모드 새 탭 이동에 사용)
   */
  const openYouTubeAtTime = (matchIndex: number, startTime: number) => {
    if (loopMode) {
      // 구간반복 모드: 즉시 재생 시작 (초기 구간 = 클릭한 세그먼트 하나)
      // 사용자는 재생 중에 아래 조정 UI로 실시간으로 시작/종료를 늘리거나 줄일 수 있음
      setLoopConfig({ matchIndex, startOffset: 0, endOffset: 0 });
      window.scrollTo({ top: 0, behavior: 'smooth' }); // 플레이어 보이도록 스크롤
    } else {
      // 일반 모드: 유튜브 새 탭으로 이동
      const timeInSeconds = Math.floor(startTime);
      window.open(`https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`, '_blank');
    }
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
        // 타임스탬프 포함: "[0:00] 텍스트\r\n[0:05] 텍스트\r\n..." 형식
        content = segments
          .map(seg => `[${formatTimestamp(seg.start)}] ${decodeHtmlEntities(seg.text.trim())}`)
          .join('\r\n');
      } else {
        // 타임스탬프 미포함: 순수 평문 — 세그먼트를 직접 조합해 엔티티 디코딩 적용
        if (segments.length > 0) {
          content = segments
            .map(seg => decodeHtmlEntities(seg.text.trim()))
            .join(' ');
        } else {
          content = decodeHtmlEntities(transcript);
        }
      }

      // Windows CRLF 정규화 (혹시 \n만 있는 줄바꿈이 있으면 \r\n으로 통일)
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

      // 메모리 해제
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);

    } catch (err) {
      console.error('다운로드 실패:', err);
      alert('파일 저장 중 오류가 발생했습니다. 복사 기능을 이용해 주세요.');
    }
  };


  // ================================================================
  // JSX 렌더링
  // ================================================================
  return (
    <div className="min-h-screen flex items-center justify-center p-4">

      {/* ── Whisper 확인 모달 ──────────────────────────────────────
          자막이 없는 영상일 때 사용자에게 Whisper STT 사용 여부 확인
          AnimatePresence: showWhisperConfirm이 false가 되면 페이드아웃 애니메이션 적용 */}
      <AnimatePresence>
        {showWhisperConfirm && (
          // 반투명 배경 오버레이
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          >
            {/* 모달 카드 */}
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="glass-card max-w-md w-full mx-4 p-8 text-center"
            >
              <div className="text-4xl mb-4">🎙️</div>
              <h2 className="text-xl font-bold text-white mb-3">자막이 없는 영상입니다</h2>
              <p className="text-gray-400 mb-6 text-sm leading-relaxed">
                이 영상에는 YouTube 자막이 없습니다.<br />
                <span className="text-indigo-400 font-medium">AI 음성인식(Whisper)</span>으로 추출할 수 있지만,<br />
                영상 길이에 따라 <span className="text-yellow-400 font-medium">수 분이 소요</span>될 수 있습니다.
              </p>
              <div className="flex gap-3">
                {/* 취소: 모달 닫고 종료 */}
                <button
                  onClick={handleWhisperCancel}
                  className="flex-1 py-3 rounded-xl border border-white/20 text-gray-300 hover:bg-white/10 transition-colors"
                >
                  취소
                </button>
                {/* 계속 진행: Whisper로 재요청 */}
                <button
                  onClick={handleWhisperConfirm}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
                >
                  계속 진행
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 메인 카드 ────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}  // 처음 마운트 시 아래서 위로 페이드인
        animate={{ opacity: 1, y: 0 }}
        className="glass-card w-full max-w-3xl"
      >
        {/* 헤더 영역: 로고 아이콘 + 타이틀 + 부제목 */}
        <header className="mb-8 flex flex-col items-center">
          <div className="p-4 bg-indigo-500/20 rounded-2xl mb-4">
            <Youtube className="w-12 h-12 text-indigo-400" />
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent mb-2">
            YouTube Scribe
          </h1>
          <p className="text-gray-400 text-lg">
            스크립트 없는 영상도 대사로 변신시켜 드립니다
          </p>
        </header>

        {/* URL 입력 폼
            onSubmit: Enter 또는 버튼 클릭 시 handleSubmit 호출 */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="input-group">
            <Youtube className="w-5 h-5 text-gray-400 mr-2 flex-shrink-0" />
            <input
              type="text"
              placeholder="유튜브 영상 링크를 입력하세요 (https://www.youtube.com/...)"
              value={url}
              onChange={(e) => {
                const val = e.target.value;
                setUrl(val);
                // URL이 바뀌면 이전 언어 목록 초기화
                setAvailableLangs([]);
                setSelectedLang('');
                setLangError('');
                // 디바운스: 유효한 YouTube URL이면 600ms 뒤에 언어 목록 자동 조회
                if (langDebounceRef.current) clearTimeout(langDebounceRef.current);
                if (YT_URL_RE.test(val)) {
                  langDebounceRef.current = setTimeout(() => fetchLanguages(val), 600);
                }
              }}
              disabled={loading}
            />
            {/* 제출 버튼 */}
            <button
              type="submit"
              className="btn-primary flex-shrink-0"
              disabled={loading || !url}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {loading ? '추출 중...' : '추출하기'}
            </button>
          </div>

          {/* 언어 선택 드롭다운: URL 입력 후 자막 언어 목록이 조회됐을 때 표시 */}
          <AnimatePresence>
            {(langLoading || availableLangs.length > 0 || langError) && (
              <motion.div
                key="lang-selector"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                {langLoading ? (
                  // 로딩 중: 스피너
                  <div className="flex items-center gap-2 text-xs text-gray-400 px-1 py-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                    이 영상의 자막 언어 목록을 불러오는 중...
                  </div>
                ) : langError ? (
                  // 자막 없는 영상: 안내 (Whisper는 추출 단계에서 제안됨)
                  <div className="flex items-center gap-2 text-xs text-yellow-400/80 px-1 py-2">
                    <span>⚠️</span>
                    이 영상에서 자막 언어를 찾지 못했습니다. 추출 시 Whisper(AI)를 제안합니다.
                  </div>
                ) : (
                  // 언어 목록 표시: 드롭다운
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                      🌐 자막 언어
                    </label>
                    <select
                      value={selectedLang}
                      onChange={(e) => handleLangChange(e.target.value)}
                      disabled={loading}
                      className="lang-select"
                    >
                      <option value="">자동 선택 (권장)</option>
                      {/* 구분선: 수동 자막 그룹 */}
                      {availableLangs.some(l => !l.is_generated) && (
                        <option disabled>── 수동 자막 ──</option>
                      )}
                      {availableLangs.filter(l => !l.is_generated).map(l => (
                        <option key={l.code} value={l.code}>{l.label}</option>
                      ))}
                      {/* 구분선: 자동 생성 자막 그룹 */}
                      {availableLangs.some(l => l.is_generated) && (
                        <option disabled>── 자동 생성 자막 ──</option>
                      )}
                      {availableLangs.filter(l => l.is_generated).map(l => (
                        <option key={`auto-${l.code}`} value={l.code}>{l.label}</option>
                      ))}
                    </select>
                    {/* 선택된 언어 배지 */}
                    {selectedLang && (
                      <span className="text-xs px-2 py-1 rounded-md bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 whitespace-nowrap flex-shrink-0">
                        {availableLangs.find(l => l.code === selectedLang)?.name ?? selectedLang}
                      </span>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </form>

        {/* ── 에러 메시지 & 자막 결과 영역 (AnimatePresence로 애니메이션) */}
        <AnimatePresence>
          {/* 에러 메시지 표시 (빨간 박스) */}
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm"
            >
              {error}
            </motion.div>
          )}

          {/* 자막 결과 영역: transcript가 있을 때만 표시 */}
          {transcript && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mt-8 space-y-4"
            >
              {/* 섹션 헤더: 제목 + 액션 버튼들 */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  추출된 대사
                </h2>
                <div className="flex items-center gap-1.5 flex-shrink-0">

                  {/* 타임스탬프 포함/제외 토글 버튼 */}
                  <button
                    onClick={() => setIncludeTimestamps(v => !v)}
                    title={includeTimestamps ? '시간 정보 포함 (클릭하면 제외)' : '시간 정보 제외 (클릭하면 포함)'}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                      includeTimestamps
                        ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                        : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200 hover:bg-white/10'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">시간</span> {includeTimestamps ? 'ON' : 'OFF'}
                  </button>

                  {/* 구간반복 모드 토글 버튼 */}
                  <button
                    onClick={() => setLoopMode(v => !v)}
                    title={loopMode ? '구간반복 ON (클릭하면 OFF)' : '구간반복 OFF (클릭하면 ON)'}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                      loopMode
                        ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                        : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200 hover:bg-white/10'
                    }`}
                  >
                    <RotateCcw
                      className={`w-3.5 h-3.5 ${loopMode ? 'animate-spin' : ''}`}
                      style={loopMode ? { animationDuration: '2s' } : {}}
                    />
                    <span className="hidden sm:inline">반복</span> {loopMode ? 'ON' : 'OFF'}
                  </button>

                  {/* 구분선 */}
                  <div className="w-px h-5 bg-white/10 mx-0.5" />

                  {/* 복사 버튼 */}
                  <button
                    onClick={copyToClipboard}
                    title="클립보드에 복사"
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/10 border border-white/10 transition-all"
                  >
                    {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? '복사됨' : '복사'}
                  </button>

                  {/* 저장 버튼 */}
                  <button
                    onClick={downloadTxt}
                    title="TXT 파일로 저장"
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white/10 border border-white/10 transition-all"
                  >
                    <Download className="w-3.5 h-3.5" />
                    저장
                  </button>
                </div>
              </div>

              {/* ─── 구간반복 플레이어 + 실시간 구간 조정 UI ───────────────
                  loopConfig가 설정되면 LoopPlayer가 바로 시작됨
                  플레이어 아래 구간 조정 컨트롤로 재생 중에 실시간으로 시작/종료 조정 */}
              {loopMode && loopConfig && loopSegment && (
                <div className="space-y-0">
                  {/* 영상 플레이어 */}
                  <LoopPlayer
                    videoId={videoId}
                    start={loopSegment.start}
                    end={loopSegment.end}
                    onClose={() => setLoopConfig(null)}
                    formatTimestamp={formatTimestamp}
                  />

                  {/* 재생 중 실시간 구간 조정 패널
                      버튼을 누르면 loopConfig의 offset이 바뀌고
                      → loopSegment(파생값)가 즉시 재계산
                      → LoopPlayer의 start/end props가 업데이트
                      → LoopPlayer 내부 ref가 업데이트되어 다음 루프부터 반영 */}
                  <div className="p-4 bg-indigo-950/80 border border-indigo-500/40 border-t-0 rounded-b-xl space-y-3">
                    {/* 헤더 */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-indigo-300 flex items-center gap-1.5">
                        <RotateCcw className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '3s' }} />
                        재생 중 구간 실시간 조정
                      </span>
                      <span className="text-xs text-gray-500">◀▶ 버튼으로 한 문장씩 조정</span>
                    </div>

                    {/* 시작 구간 조정 */}
                    <div className="space-y-1">
                      <p className="text-xs text-indigo-400/70 font-medium">시작 구간</p>
                      <div className="flex items-center gap-2">
                        {/* 시작을 한 세그먼트 더 앞으로 (범위 확장) */}
                        <button
                          onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.min(c.startOffset + 1, c.matchIndex) } : null)}
                          disabled={loopSegment.startSegIdx === 0}
                          title="시작을 한 문장 앞으로"
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10 hover:bg-indigo-500/40 text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-sm font-bold"
                        >◀</button>
                        {/* 현재 시작 세그먼트 미리보기 */}
                        <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-black/30 rounded-lg border border-indigo-500/30 min-w-0">
                          <span className="text-xs font-mono text-indigo-300 flex-shrink-0 font-semibold">
                            {formatTimestamp(loopSegment.startSeg.start)}
                          </span>
                          <span className="text-xs text-gray-300 truncate">
                            {loopSegment.startSeg.text.trim()}
                          </span>
                        </div>
                        {/* 시작을 한 세그먼트 뒤로 (범위 축소) */}
                        <button
                          onClick={() => setLoopConfig(c => c ? { ...c, startOffset: Math.max(0, c.startOffset - 1) } : null)}
                          disabled={loopConfig.startOffset === 0}
                          title="시작을 한 문장 뒤로"
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10 hover:bg-indigo-500/40 text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-sm font-bold"
                        >▶</button>
                      </div>
                    </div>

                    {/* 종료 구간 조정 */}
                    <div className="space-y-1">
                      <p className="text-xs text-indigo-400/70 font-medium">종료 구간</p>
                      <div className="flex items-center gap-2">
                        {/* 종료를 한 세그먼트 앞으로 (범위 축소) */}
                        <button
                          onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.max(0, c.endOffset - 1) } : null)}
                          disabled={loopConfig.endOffset === 0}
                          title="종료를 한 문장 앞으로"
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10 hover:bg-indigo-500/40 text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-sm font-bold"
                        >◀</button>
                        {/* 현재 종료 세그먼트 미리보기 */}
                        <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-black/30 rounded-lg border border-indigo-500/30 min-w-0">
                          <span className="text-xs font-mono text-indigo-300 flex-shrink-0 font-semibold">
                            {formatTimestamp(loopSegment.endSeg.start + loopSegment.endSeg.duration)}
                          </span>
                          <span className="text-xs text-gray-300 truncate">
                            {loopSegment.endSeg.text.trim()}
                          </span>
                        </div>
                        {/* 종료를 한 세그먼트 뒤로 (범위 확장) */}
                        <button
                          onClick={() => setLoopConfig(c => c ? { ...c, endOffset: Math.min(c.endOffset + 1, segments.length - 1 - c.matchIndex) } : null)}
                          disabled={loopSegment.endSegIdx >= segments.length - 1}
                          title="종료를 한 문장 뒤로"
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10 hover:bg-indigo-500/40 text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-sm font-bold"
                        >▶</button>
                      </div>
                    </div>

                    {/* 현재 구간 요약 표시 */}
                    <div className="flex items-center justify-between pt-2 border-t border-indigo-500/20">
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <RotateCcw className="w-3 h-3 text-indigo-400" />
                        현재 반복 구간:
                        <span className="text-indigo-300 font-mono ml-1">{formatTimestamp(loopSegment.start)}</span>
                        <span className="text-gray-500">~</span>
                        <span className="text-indigo-300 font-mono">{formatTimestamp(loopSegment.end)}</span>
                        <span className="text-gray-500 ml-1">
                          ({Math.floor(loopSegment.end - loopSegment.start)}초)
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* 자막 텍스트 표시 영역 (스크롤 가능, max-height 500px) */}
              <div className="transcript-area">
                {transcript}
              </div>

              {/* ── 검색 섹션 ──────────────────────────────────────── */}
              <div className="mt-6 space-y-3">

                {/* 검색어 입력창 + 검색 버튼
                    flex-nowrap: 버튼이 줄 바꿈으로 내려가지 않도록 강제
                    min-w-0: input-group이 찌그러져도 버튼이 밀리지 않음 */}
                <div className="flex items-center gap-2 flex-nowrap">
                  <div className="input-group flex-1 min-w-0">
                    <Search className="w-5 h-5 text-gray-400 mr-2 flex-shrink-0" />
                    <input
                      type="text"
                      placeholder="검색할 구문을 입력하세요..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    />
                  </div>
                  <button
                    onClick={handleSearch}
                    className="btn-primary flex-shrink-0"
                  >
                    <Search className="w-4 h-4" />
                    검색
                  </button>
                </div>

                {/* 검색 결과 목록 (AnimatePresence로 부드러운 등장/퇴장) */}
                <AnimatePresence mode="sync">
                  {/* 결과 목록 */}
                  {searchResults.length > 0 && (
                    <motion.div
                      key="search-results"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2"
                    >
                      {/* 결과 개수 헤더 */}
                      <h3 className="text-sm font-semibold text-gray-400 flex items-center gap-2">
                        <Clock className="w-4 h-4" />
                        검색 결과 ({searchResults.length}개)
                        {loopMode && <span className="text-xs text-indigo-400 font-normal">— 클릭하면 해당 구간부터 반복 재생</span>}
                      </h3>

                      {/* 결과 카드 목록 */}
                      <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                        {searchResults.map((result, idx) => (
                          <motion.div
                            key={`${result.matchIndex}-${idx}`}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: Math.min(idx * 0.04, 0.3) }}
                            onClick={() => openYouTubeAtTime(result.matchIndex, result.segment.start)}
                            className={`p-3 rounded-xl cursor-pointer transition-all border ${
                              loopMode && loopConfig?.matchIndex === result.matchIndex
                                ? 'bg-indigo-600/25 border-indigo-400/60 shadow-sm shadow-indigo-900/50'
                                : 'bg-white/[0.06] hover:bg-white/[0.12] border-white/[0.08] hover:border-indigo-500/40'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              {/* 타임스탬프 배지 */}
                              <div className="flex-shrink-0 px-2 py-1 bg-indigo-500/20 rounded text-indigo-400 text-xs font-mono">
                                {formatTimestamp(result.segment.start)}
                              </div>
                              {/* 자막 텍스트 */}
                              <p className="text-sm text-gray-300 flex-1">
                                {result.segment.text}
                              </p>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* 검색어가 있고 결과가 0개일 때: "없음" 안내 메시지 */}
                  {searchQuery && searchResults.length === 0 && segments.length > 0 && (
                    <motion.div
                      key="no-results"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-yellow-400 text-sm"
                    >
                      '{searchQuery}' 검색 결과가 없습니다.
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

            </motion.div>
          )}
        </AnimatePresence>

        {/* ── 로딩 스피너 ──────────────────────────────────────────
            백엔드 요청 중(loading=true)일 때만 표시 */}
        {loading && (
          <div className="mt-8 flex flex-col items-center gap-4 py-8">
            {/* 바깥 링은 스핀, 안쪽엔 YouTube 아이콘 */}
            <div className="relative">
              <div className="w-16 h-16 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <Youtube className="w-6 h-6 text-indigo-500" />
              </div>
            </div>
            <p className="text-gray-400 animate-pulse">
              AI가 영상을 분석하고 있습니다. 영상 길이에 따라 몇 분 정도 소요될 수 있습니다...
            </p>
          </div>
        )}
      </motion.div>
    </div>
  );
}

export default App;
