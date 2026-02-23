# YouTube Scribe

🎥 **YouTube 영상의 대사를 AI로 자동 추출하고 검색할 수 있는 웹 애플리케이션**

## 주요 기능

- ✅ **대사 추출**: YouTube 내장 자막 우선 사용, 없을 경우 Whisper AI로 음성 인식
- 🔍 **구문 검색**: 특정 단어/구문이 나오는 모든 시간대를 검색
- 🔄 **구간반복 모드**: 검색 결과 클릭 시 YouTube IFrame API로 해당 구간만 앱 내에서 반복 재생
- 📋 **대사 저장**: 추출된 대사를 복사하거나 텍스트 파일(UTF-8)로 저장
- 🕐 **타임스탬프 포함 저장**: 저장 시 `[0:00] 텍스트` 형식으로 시간 정보 포함 선택 가능

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
- **FFmpeg** (Whisper 음성인식 사용 시 필요 — 아래 설치 가이드 참고)

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

# 현위치에서 Python 가상 환경(venv 폴더명으로) 생성
python -m venv venv
venv\Scripts\activate  # Windows. 만들어 둔 venv 폴더로 들어가서 가상환경 활성화
# source venv/bin/activate  # Mac/Linux

# 의존성 설치 (기본 기능)
pip install fastapi uvicorn youtube-transcript-api yt-dlp pydantic

# Whisper 음성인식 사용 시 추가 설치 (선택)
pip install openai-whisper

# 백엔드 서버 실행
python -m uvicorn main:app --reload
```

백엔드는 `http://localhost:8000`에서 실행됩니다.

### 3. FFmpeg 설치 (Whisper 사용 시 필수)

Whisper AI 음성인식으로 자막 없는 영상의 대사를 추출하려면 FFmpeg가 필요합니다.  
**YouTube 자막이 있는 영상만 사용할 경우 FFmpeg 설치는 필요 없습니다.**

1. **FFmpeg 다운로드**
   - 다운로드 페이지: https://www.gyan.dev/ffmpeg/builds/#release-builds
   - **`ffmpeg-release-essentials.zip`** 파일을 다운로드합니다.
   - (또는 직접 링크: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip)

2. **압축 해제**
   - 다운로드한 zip 파일의 내용물을 `backend/ffmpeg/` 폴더에 압축 해제합니다.
   - 최종 구조가 아래와 같으면 됩니다:

   ```
   backend/
   └── ffmpeg/
       └── ffmpeg-X.X.X-essentials_build/   ← 버전 번호는 달라도 OK
           ├── bin/
           │   ├── ffmpeg.exe    ← 이 파일이 있으면 자동 인식
           │   ├── ffprobe.exe
           │   └── ffplay.exe
           ├── doc/
           └── ...
   ```

3. **설치 확인**
   - 백엔드 서버 실행 시 로그에 `FFmpeg found at ...` 메시지가 출력되면 정상입니다.
   - 서버가 `backend/ffmpeg/` 하위를 자동 탐색하므로 버전이 달라도 동작합니다.

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
   - 상단 "반복 OFF" 버튼 클릭 → "반복 ON"으로 활성화
   - 검색 결과 클릭 시 앱 내부 YouTube 플레이어가 열려 해당 구간만 반복 재생
   - "✕ 닫기" 버튼으로 플레이어 닫기
   - 새 URL을 검색하면 반복 플레이어는 자동으로 닫힘

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

#### 5. 구간반복 재생

```
일반 모드:   새 탭에서 youtube.com/watch?v=ID&t=80s 열기
구간반복 모드: YouTube IFrame API를 사용해 앱 내부에서 start~end 구간 반복
```

> **왜 URL 파라미터 방식을 쓰지 않나요?**  
> `&start=80&end=95&loop=1` 파라미터는 YouTube 웹사이트에서 무시됩니다.  
> 구간반복을 실제로 구현하려면 IFrame API + JavaScript 제어가 필수입니다.  
> 자세한 내용은 [`docs/technical-decisions.md`](docs/technical-decisions.md)를 참고하세요.

## 프로젝트 구조

```
youtube-scribe/
├── backend/
│   ├── main.py              # FastAPI 백엔드 서버
│   ├── ffmpeg/              # FFmpeg 실행 파일 (수동 설치 — README 참고)
│   └── test_*.py            # 테스트 스크립트
├── docs/
│   └── technical-decisions.md  # 기술 결정 기록 (왜 이렇게 만들었는가)
├── src/
│   ├── App.tsx              # 메인 React 컴포넌트 (LoopPlayer 포함)
│   ├── main.tsx             # React 엔트리 포인트
│   └── index.css            # 전역 스타일
├── .agent/
│   └── workflows/           # 개발 가이드라인 (주석 규칙 등)
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
- FFmpeg가 `backend/ffmpeg/` 폴더에 설치되어 있는지 확인
- 위의 [FFmpeg 설치 가이드](#3-ffmpeg-설치-whisper-사용-시-필수) 참고
- 다운로드: https://www.gyan.dev/ffmpeg/builds/#release-builds
- `ffmpeg-release-essentials.zip`을 받아 `backend/ffmpeg/`에 압축 해제

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
