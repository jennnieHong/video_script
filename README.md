# YouTube Scribe

🎥 **YouTube 영상의 대사를 AI로 자동 추출하고 검색할 수 있는 웹 애플리케이션**

## 주요 기능

- ✅ **대사 추출**: Whisper AI를 사용하여 YouTube 영상의 음성을 텍스트로 변환
- 🔍 **구문 검색**: 특정 단어/구문이 나오는 모든 시간대를 검색
- 🔄 **구간반복 모드**: 검색 결과 클릭 시 해당 구간만 반복 재생하는 YouTube 링크 생성
- 📋 **대사 저장**: 추출된 대사를 복사하거나 텍스트 파일로 저장

## 기술 스택

### Frontend
- **React** + **TypeScript** + **Vite**
- **Tailwind CSS** (스타일링)
- **Framer Motion** (애니메이션)
- **Axios** (HTTP 클라이언트)

### Backend
- **FastAPI** (Python 웹 프레임워크)
- **OpenAI Whisper** (음성 인식 AI)
- **yt-dlp** (YouTube 다운로더)
- **FFmpeg** (오디오 처리)

## 설치 및 실행

### 필수 요구사항

- **Node.js** 18.17.0 이상
- **Python** 3.8 이상
- **FFmpeg** (자동 설치됨)

### 1. 프론트엔드 설정

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

프론트엔드는 `http://localhost:5173`에서 실행됩니다.

### 2. 백엔드 설정

```bash
# backend 디렉토리로 이동
cd backend

# Python 가상 환경 생성 (선택사항)
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Mac/Linux

# 의존성 설치
pip install fastapi uvicorn yt-dlp openai-whisper

# 백엔드 서버 실행
python -m uvicorn main:app --reload
```

백엔드는 `http://localhost:8000`에서 실행됩니다.

## 사용 방법

1. **YouTube URL 입력**
   - 추출하고 싶은 YouTube 영상 URL을 입력창에 붙여넣기
   - "추출하기" 버튼 클릭

2. **대사 추출 대기**
   - 영상 다운로드 → 오디오 추출 → 음성 인식 순으로 진행
   - 영상 길이에 비례하여 시간 소요 (예: 5분 영상 ≈ 2-3분 소요)
   - 로딩 애니메이션이 표시됨

3. **추출된 대사 확인**
   - 전체 대사가 화면에 표시됨
   - "복사" 버튼으로 클립보드에 복사
   - "저장" 버튼으로 텍스트 파일로 다운로드

4. **구문 검색**
   - 검색창에 찾고 싶은 단어나 구문 입력
   - 해당 단어가 나오는 모든 타임스탬프 확인
   - 결과 클릭 시 YouTube에서 해당 시간대로 이동

5. **구간반복 모드**
   - "구간반복 모드" 토글 활성화
   - 검색 결과 클릭 시 해당 구간만 반복 재생되는 YouTube 링크 생성

## 로그 확인 방법

### 프론트엔드 로그 (브라우저)

1. **F12** 키를 눌러 개발자 도구 열기
2. **Console** 탭 클릭
3. 네트워크 요청, JavaScript 에러 등 확인

### 백엔드 로그 (터미널)

**VS Code에서:**
- 화면 하단 "터미널" 패널 열기
- `python -m uvicorn main:app --reload` 실행 중인 터미널 확인
- 다음과 같은 로그 표시:
  ```
  INFO:     Processing video ID: xxxxx using Whisper STT
  INFO:     Starting Whisper transcription...
  INFO:     FFmpeg location: D:\workspace\youtube-scribe\backend\ffmpeg\...
  [download] 45.2% of 15.23MiB at 2.5MiB/s ETA 00:03
  INFO:     Transcription complete. Found 42 segments.
  ```

**일반 터미널에서:**
- 백엔드를 실행한 터미널 창 확인
- 실시간으로 진행 상황 표시

## 구동 원리

### 전체 흐름

```
[사용자] → [프론트엔드] → [백엔드] → [YouTube] → [FFmpeg] → [Whisper AI]
                ↓                                                      ↓
             [결과 표시] ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← [대사 텍스트]
```

### 상세 단계

#### 1. 프론트엔드 (React)
- 사용자가 YouTube URL 입력
- `axios.post('http://localhost:8000/transcribe', { url })` 호출
- 로딩 상태 표시
- 결과 수신 후 화면에 렌더링

#### 2. 백엔드 (FastAPI)
```python
@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    # 1. YouTube URL에서 video_id 추출
    video_id = extract_video_id(request.url)
    
    # 2. yt-dlp로 영상 다운로드
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([request.url])
    
    # 3. FFmpeg로 오디오 추출 (.mp3)
    # 4. Whisper AI로 음성 인식
    model = whisper.load_model("base")
    result = model.transcribe(audio_path)
    
    # 5. 결과 반환 (대사 + 타임스탬프)
    return {
        "transcript": result["text"],
        "segments": segments,
        "video_id": video_id
    }
```

#### 3. Whisper AI 처리
- OpenAI의 음성 인식 모델
- 오디오 파일을 텍스트로 변환
- 각 문장의 시작/종료 시간 포함

#### 4. 검색 기능
- 프론트엔드에서 `segments` 배열 검색
- 입력한 구문이 포함된 모든 구간 필터링
- 타임스탬프와 함께 표시

#### 5. 구간반복 링크 생성
```typescript
// 일반 모드
https://www.youtube.com/watch?v={video_id}&t={start_time}s

// 구간반복 모드
https://www.youtube.com/watch?v={video_id}&start={start}&end={end}&loop=1&playlist={video_id}
```

## 프로젝트 구조

```
youtube-scribe/
├── backend/
│   ├── main.py              # FastPI 백엔드 서버
│   ├── ffmpeg/              # FFmpeg 실행 파일 (자동 다운로드)
│   └── test_*.py            # 테스트 스크립트
├── src/
│   ├── App.tsx              # 메인 React 컴포넌트
│   ├── main.tsx             # React 엔트리 포인트
│   └── index.css            # 전역 스타일
├── package.json             # Node.js 의존성
├── vite.config.ts           # Vite 설정
└── README.md                # 이 파일
```

## 문제 해결 (Troubleshooting)

### 백엔드가 시작되지 않음
```bash
# Python 의존성 재설치
pip install --upgrade fastapi uvicorn yt-dlp openai-whisper
```

### "FFmpeg not found" 에러
- FFmpeg는 자동으로 `backend/ffmpeg/` 폴더에 다운로드됨
- 수동 설치 필요 시: https://ffmpeg.org/download.html

### 프론트엔드가 백엔드에 연결 안 됨
- 백엔드가 `http://localhost:8000`에서 실행 중인지 확인
- CORS 설정이 올바른지 확인 (`main.py`의 `CORSMiddleware`)

### 추출이 너무 오래 걸림
- 영상 길이에 비례하여 시간 소요
- 짧은 영상(1-2분)으로 먼저 테스트 권장
- Whisper 모델을 "tiny"로 변경하면 더 빠름 (정확도 ↓)
  ```python
  model = whisper.load_model("tiny")  # base → tiny
  ```

## 향후 개선 사항

- [ ] 실시간 진행률 표시 (WebSocket)
- [ ] 자막이 있는 영상은 YouTube API로 빠르게 추출
- [ ] 여러 언어 지원
- [ ] 추출 결과 캐싱
- [ ] 대사 편집 기능

## 라이선스

MIT License

## 기여

이슈 및 풀 리퀘스트 환영합니다!
