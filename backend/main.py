# 라이브러리 임포트. venv 활성화 필수. backend/venv 생성된 가상환경 폴더, 가상환경을 활성화하면 이 폴더 안의 설정을 읽어서 실행됨
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from youtube_transcript_api import YouTubeTranscriptApi
import yt_dlp
try:
    import whisper
except ImportError:
    whisper = None  # Whisper 미설치 시 lazy import로 처리
import os
import re
import tempfile
from pathlib import Path
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FFmpeg configuration
# backend/ffmpeg/ 하위에서 bin/ffmpeg.exe를 자동 탐색 (버전에 무관하게 동작)
BASE_DIR = Path(__file__).resolve().parent
FFMPEG_DIR = BASE_DIR / "ffmpeg"
FFMPEG_BIN_DIR = ""
FFMPEG_PATH = ""
FFPROBE_PATH = ""

if FFMPEG_DIR.exists():
    # backend/ffmpeg/ 하위 폴더에서 bin/ffmpeg.exe를 재귀적으로 탐색
    for candidate in FFMPEG_DIR.rglob("ffmpeg.exe"):
        FFMPEG_BIN_DIR = str(candidate.parent)
        FFMPEG_PATH = str(candidate)
        FFPROBE_PATH = str(candidate.parent / "ffprobe.exe")
        break

# Add FFmpeg to PATH
if FFMPEG_BIN_DIR and FFMPEG_BIN_DIR not in os.environ.get('PATH', ''):
    os.environ['PATH'] = FFMPEG_BIN_DIR + os.pathsep + os.environ.get('PATH', '')
    logger.info(f"Added FFmpeg bin directory to PATH: {FFMPEG_BIN_DIR}")

# Verify FFmpeg exists
if not FFMPEG_PATH or not os.path.exists(FFMPEG_PATH):
    logger.warning(
        "⚠️ FFmpeg not found! Whisper 기능을 사용하려면 FFmpeg를 설치해야 합니다.\n"
        "   다운로드: https://www.gyan.dev/ffmpeg/builds/#release-builds\n"
        "   'ffmpeg-release-essentials.zip'을 받아 backend/ffmpeg/ 에 압축 해제하세요."
    )
else:
    logger.info(f"FFmpeg found at {FFMPEG_PATH}")

app = FastAPI()

# Enable CORS for React: 프론트엔드(React)에서 백엔드에 접근할 수 있도록 허용하는 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 언어 코드 → 한국어 표시명 매핑 ────────────────────────────────
LANGUAGE_NAMES = {
    "ko": "한국어",
    "en": "영어",
    "ja": "일본어",
    "zh": "중국어 (간체)",
    "zh-TW": "중국어 (번체)",
    "zh-Hant": "중국어 (번체)",
    "zh-Hans": "중국어 (간체)",
    "es": "스페인어",
    "fr": "프랑스어",
    "de": "독일어",
    "pt": "포르투갈어",
    "ru": "러시아어",
    "ar": "아랍어",
    "hi": "힌디어",
    "it": "이탈리아어",
    "nl": "네덜란드어",
    "pl": "폴란드어",
    "tr": "터키어",
    "th": "태국어",
    "vi": "베트남어",
    "id": "인도네시아어",
    "sv": "스웨덴어",
    "da": "덴마크어",
    "no": "노르웨이어",
    "fi": "핀란드어",
}

def get_language_name(code: str) -> str:
    """언어 코드를 받아 표시 이름을 반환. 알 수 없으면 코드 그대로 반환."""
    if code in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[code]
    base = code.split("-")[0].lower()
    if base in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[base]
    return code  # 매핑 없으면 코드 원본 반환

def extract_video_id(url):
    pattern = r'(?:v=|\/)([0-9A-Za-z_-]{11}).*'
    match = re.search(pattern, url)
    return match.group(1) if match else None

# ─── 요청 모델 ──────────────────────────────────────────────────────

class LanguagesRequest(BaseModel):
    url: str

class TranscribeRequest(BaseModel):
    url: str
    use_whisper: bool = False  # True면 Whisper STT 사용
    language: str = ""         # "" = 자동선택, 그 외 = 언어 코드 (예: "ko", "en")

# ─── 엔드포인트 ─────────────────────────────────────────────────────

@app.post("/languages")
async def get_languages(request: LanguagesRequest):
    """
    YouTube 영상에서 사용 가능한 자막 언어 목록을 반환합니다.
    수동 자막과 자동 생성 자막을 구분하여 제공합니다.
    """
    video_id = extract_video_id(request.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")

    try:
        api = YouTubeTranscriptApi()
        transcript_list = api.list(video_id)

        languages = []
        for t in transcript_list:
            lang_code = t.language_code
            is_generated = t.is_generated  # True = 자동 생성 자막
            lang_name = get_language_name(lang_code)

            languages.append({
                "code": lang_code,
                "name": lang_name,
                "is_generated": is_generated,
                "label": f"{lang_name}{' (자동생성)' if is_generated else ''}",
            })

        # 정렬: 수동 자막 먼저 → 자동생성, 각 그룹 내 이름 가나다순
        languages.sort(key=lambda x: (x["is_generated"], x["name"]))

        logger.info(f"✅ 언어 목록 조회 완료: {[l['code'] for l in languages]}")
        return {
            "video_id": video_id,
            "languages": languages,
        }

    except Exception as e:
        logger.warning(f"⚠️ 언어 목록 조회 실패: {e}")
        raise HTTPException(status_code=404, detail=f"자막 정보를 가져올 수 없습니다: {str(e)}")


@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    video_id = extract_video_id(request.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")

    # ─── 1단계: YouTube 자막 API (use_whisper=True면 건너뜀) ──────
    if not request.use_whisper:
        try:
            logger.info(f"[1/2] YouTube 자막 API로 시도 중... video_id={video_id}, language='{request.language}'")
            api = YouTubeTranscriptApi()

            transcript_data = None
            used_language = None

            if request.language:
                # 사용자가 특정 언어를 선택한 경우 해당 언어 우선 시도
                try:
                    transcript_data = api.fetch(video_id, languages=[request.language])
                    used_language = [request.language]
                except Exception as e:
                    logger.warning(f"선택 언어({request.language}) 자막 실패, fallback 시도: {e}")

            if transcript_data is None:
                # 언어 미지정이거나 선택 언어 실패 시: 기본 우선순위로 폴백
                for lang in [['ko'], ['en'], ['ko', 'en']]:
                    try:
                        transcript_data = api.fetch(video_id, languages=lang)
                        used_language = lang
                        break
                    except Exception:
                        continue

            if transcript_data is None:
                # 마지막 수단: 언어 무관하게 첫 번째 자막
                transcript_data = api.fetch(video_id)
                used_language = ['auto']

            segments = []
            for snippet in transcript_data:
                segments.append({
                    "start": snippet.start,
                    "duration": snippet.duration,
                    "text": snippet.text
                })

            transcript_text = " ".join(s["text"] for s in segments)
            logger.info(f"✅ YouTube 자막 API 성공! {len(segments)}개 세그먼트 ({used_language})")

            return {
                "transcript": transcript_text,
                "segments": segments,
                "video_id": video_id,
                "method": "api",
                "language": used_language[0] if used_language else "unknown",
            }

        except Exception as e:
            logger.warning(f"⚠️ YouTube 자막 API 실패: {e}")
            return {
                "status": "no_subtitle",
                "video_id": video_id,
                "message": "이 영상에는 자막이 없습니다. AI 음성인식(Whisper)으로 추출할 수 있지만 영상 길이에 따라 수 분이 소요될 수 있습니다. 계속 진행하시겠습니까?"
            }

    # ─── 2단계: Whisper STT ───────────────────────────────────────
    try:
        logger.info("[2/2] Whisper STT 시작...")
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = os.path.join(temp_dir, "audio")

            ydl_opts = {
                'format': 'bestaudio/best',
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }],
                'outtmpl': audio_path,
                'quiet': False,
                'ffmpeg_location': os.path.dirname(FFMPEG_PATH),
            }

            logger.info(f"yt-dlp 다운로드 시작...")
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([request.url])

            actual_audio_path = audio_path + ".mp3"
            if not os.path.exists(actual_audio_path):
                if os.path.exists(audio_path):
                    actual_audio_path = audio_path
                else:
                    raise FileNotFoundError(f"오디오 파일을 찾을 수 없습니다: {actual_audio_path}")

            logger.info("Whisper 모델 로딩...")
            model = whisper.load_model("base")
            logger.info(f"음성 인식 시작: {actual_audio_path}")
            result = model.transcribe(actual_audio_path)

            segments = [{
                "start": seg['start'],
                "duration": seg['end'] - seg['start'],
                "text": seg['text']
            } for seg in result.get("segments", [])]

            logger.info(f"✅ Whisper 완료! {len(segments)}개 세그먼트")
            return {
                "transcript": result["text"],
                "segments": segments,
                "video_id": video_id,
                "method": "whisper",
                "language": result.get("language", "unknown"),
            }

    except Exception as e:
        logger.error(f"❌ Whisper 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"대사 추출에 실패했습니다: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
