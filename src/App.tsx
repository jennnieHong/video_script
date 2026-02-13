import { useState } from 'react';
import { Youtube, Send, Copy, Download, Loader2, FileText, CheckCircle2, Search, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';

interface Segment {
  start: number;
  duration: number;
  text: string;
}

interface SearchResult {
  segment: Segment;
  matchIndex: number;
}

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [videoId, setVideoId] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loopMode, setLoopMode] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError('');
    setTranscript('');
    setSegments([]);
    setSearchQuery('');
    setSearchResults([]);

    try {
      // 타임아웃 설정 (10분)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000); // 10분

      const response = await axios.post('http://localhost:8000/transcribe', 
        { url }, 
        { 
          signal: controller.signal,
          timeout: 600000 // 10분
        }
      );
      
      clearTimeout(timeoutId);
      
      setTranscript(response.data.transcript);
      setSegments(response.data.segments || []);
      setVideoId(response.data.video_id || '');
      
      // 성공 알림
      console.log('✅ 추출 완료!', response.data.segments?.length, '개의 세그먼트');
      
    } catch (err: any) {
      console.error('❌ 추출 실패:', err);
      
      // 더 상세한 에러 메시지
      let errorMessage = '대사를 추출하는 중 오류가 발생했습니다.';
      
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        errorMessage = '⏱️ 처리 시간이 너무 오래 걸립니다. 더 짧은 영상으로 시도해주세요.';
      } else if (err.response?.status === 500) {
        errorMessage = `🔧 서버 오류: ${err.response?.data?.detail || '백엔드 처리 중 문제가 발생했습니다.'}`;
      } else if (err.response?.status === 400) {
        errorMessage = `❌ 잘못된 요청: ${err.response?.data?.detail || '올바른 YouTube URL을 입력해주세요.'}`;
      } else if (!err.response) {
        errorMessage = '🔌 백엔드 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.';
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTimestamp = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSearch = () => {
    if (!searchQuery.trim() || segments.length === 0) {
      setSearchResults([]);
      return;
    }

    const query = searchQuery.toLowerCase();
    const results: SearchResult[] = [];

    segments.forEach((segment, index) => {
      if (segment.text.toLowerCase().includes(query)) {
        results.push({ segment, matchIndex: index });
      }
    });

    setSearchResults(results);
  };

  const openYouTubeAtTime = (startTime: number, duration?: number) => {
    const timeInSeconds = Math.floor(startTime);
    let youtubeUrl = `https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`;
    
    // Add loop parameters if loop mode is enabled and duration is provided
    if (loopMode && duration) {
      const endTime = Math.floor(startTime + duration);
      youtubeUrl = `https://www.youtube.com/watch?v=${videoId}&start=${timeInSeconds}&end=${endTime}&loop=1&playlist=${videoId}`;
    }
    
    window.open(youtubeUrl, '_blank');
  };

  const downloadTxt = () => {
    const element = document.createElement("a");
    const file = new Blob([transcript], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = "transcript.txt";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card w-full max-w-3xl"
      >
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="input-group">
            <Youtube className="w-5 h-5 text-gray-400 mr-2" />
            <input 
              type="text" 
              placeholder="유튜브 영상 링크를 입력하세요 (https://www.youtube.com/...)" 
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
            <button 
              type="submit" 
              className="btn-primary"
              disabled={loading || !url}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {loading ? '추출 중...' : '추출하기'}
            </button>
          </div>
        </form>

        <AnimatePresence>
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

          {transcript && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mt-8 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  추출된 대사
                </h2>
                <div className="flex gap-2">
                  <button 
                    onClick={copyToClipboard}
                    className="p-2 hover:bg-white/5 rounded-lg transition-colors flex items-center gap-2 text-sm text-gray-300"
                  >
                    {copied ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    {copied ? '복사됨' : '복사'}
                  </button>
                  <button 
                    onClick={downloadTxt}
                    className="p-2 hover:bg-white/5 rounded-lg transition-colors flex items-center gap-2 text-sm text-gray-300"
                  >
                    <Download className="w-4 h-4" />
                    저장
                  </button>
                </div>
              </div>
              
              <div className="transcript-area">
                {transcript}
              </div>

              {/* Search Section */}
              <div className="mt-6 space-y-4">
                {/* Loop Mode Toggle */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-indigo-500/20 rounded">
                      <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-200">구간반복 모드</p>
                      <p className="text-xs text-gray-400">검색 결과 클릭 시 해당 구간만 반복 재생</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setLoopMode(!loopMode)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      loopMode ? 'bg-indigo-500' : 'bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        loopMode ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <div className="input-group flex-1">
                    <Search className="w-5 h-5 text-gray-400 mr-2" />
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
                    className="btn-primary whitespace-nowrap"
                  >
                    <Search className="w-4 h-4" />
                    검색
                  </button>
                </div>

                {/* Search Results */}
                <AnimatePresence>
                  {searchResults.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2"
                    >
                      <h3 className="text-sm font-semibold text-gray-400 flex items-center gap-2">
                        <Clock className="w-4 h-4" />
                        검색 결과 ({searchResults.length}개)
                      </h3>
                      <div className="max-h-64 overflow-y-auto space-y-2">
                        {searchResults.map((result, idx) => (
                          <motion.div
                            key={idx}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.05 }}
                            onClick={() => openYouTubeAtTime(result.segment.start, result.segment.duration)}
                            className="p-3 bg-white/5 hover:bg-white/10 rounded-lg cursor-pointer transition-colors border border-white/10 hover:border-indigo-500/50"
                          >
                            <div className="flex items-start gap-3">
                              <div className="flex-shrink-0 px-2 py-1 bg-indigo-500/20 rounded text-indigo-400 text-xs font-mono">
                                {formatTimestamp(result.segment.start)}
                              </div>
                              <p className="text-sm text-gray-300 flex-1">
                                {result.segment.text}
                              </p>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                  {searchQuery && searchResults.length === 0 && segments.length > 0 && (
                    <motion.div
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

        {loading && (
          <div className="mt-8 flex flex-col items-center gap-4 py-8">
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
