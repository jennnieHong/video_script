# 라이브러리 임포트. venv 활성화 필수. backend/venv 생성된 가상환경 폴더, 가상환경을 활성화하면 이 폴더 안의 설정을 읽어서 실행됨
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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
import json
import threading
import asyncio
import subprocess
import time
import shutil
try:
    import cv2
    import mediapipe as mp
except ImportError:
    cv2 = None
    mp = None

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


# ─── 클립 다운로드 엔드포인트 ────────────────────────────────────
from fastapi.responses import FileResponse
from fastapi import BackgroundTasks
import subprocess
import glob

class ClipRequest(BaseModel):
    url: str
    start: float     # 시작 시간 (초)
    end: float        # 종료 시간 (초)
    quality: str = "720"  # 360|480|720|1080|best|vertical

@app.post("/clip")
async def download_clip(request: ClipRequest, background_tasks: BackgroundTasks):
    url = request.url
    start = request.start
    end = request.end
    quality = request.quality
    """
    YouTube 영상의 특정 구간을 MP4 파일로 다운로드합니다. (POST)
    body: { url, start, end, quality }
    quality: 360 | 480 | 720 | 1080 | best | vertical
    """
    video_id = extract_video_id(url)
    request_url = url
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")

    if end <= start:
        raise HTTPException(status_code=400, detail="종료 시간이 시작 시간보다 커야 합니다.")

    temp_dir = tempfile.mkdtemp()
    raw_path = os.path.join(temp_dir, f"raw_{video_id}.mp4")
    clip_path = os.path.join(temp_dir, f"clip_{video_id}_{int(start)}s-{int(end)}s.mp4")

    try:
        # ── 1단계: yt-dlp로 영상 다운로드 (전체) ───────────────────
        # quality 파라미터에 따른 yt-dlp format 문자열 생성
        # H.264(avc1) 코덱 우선 → MP4 네이티브, 색감 보존
        QUALITY_MAP = {
            '360':  'bestvideo[vcodec^=avc1][height<=360]+bestaudio[acodec^=mp4a]/best[height<=360]/best',
            '480':  'bestvideo[vcodec^=avc1][height<=480]+bestaudio[acodec^=mp4a]/best[height<=480]/best',
            '720':  'bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/best[height<=720]/best',
            '1080': 'bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/best[height<=1080]/best',
            'best': 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best',
        }
        fmt = QUALITY_MAP.get(quality, QUALITY_MAP['720'])
        ydl_opts = {
            'format': fmt,
            'merge_output_format': 'mp4',  # 항상 MP4로 머지
            'outtmpl': raw_path,
            'quiet': True,
            'no_warnings': True,
        }
        if FFMPEG_PATH:
            ydl_opts['ffmpeg_location'] = os.path.dirname(FFMPEG_PATH)

        logger.info(f"🎬 영상 다운로드 시작: {video_id}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([request_url])

        # yt-dlp가 실제로 저장한 파일 찾기 (확장자가 다를 수 있음)
        if not os.path.exists(raw_path):
            candidates = glob.glob(os.path.join(temp_dir, f"raw_{video_id}.*"))
            if not candidates:
                raise FileNotFoundError("다운로드된 영상 파일을 찾을 수 없습니다.")
            raw_path = candidates[0]

        # ── 2단계: ffmpeg로 구간 자르기 ─────────────────────────────
        duration = end - start
        ffmpeg_exe = FFMPEG_PATH if FFMPEG_PATH else "ffmpeg"

        if quality == "vertical":
            # 📱 세로 영상 (9:16) 변환
            # crop=ih*9/16:ih  → 세로 기준으로 가운데 크롭 (가로 여백 제거)
            # 세로 크롭은 픽셀 재계산이 필요하므로 재인코딩 필수 (copy 불가)
            logger.info(f"📱 세로 영상 변환 포함: crop=9:16")
            cmd = [
                ffmpeg_exe,
                "-y",
                "-ss", str(start),
                "-i", raw_path,
                "-t", str(duration),
                "-vf", "crop=ih*9/16:ih",   # 9:16 비율로 가운데 크롭
                "-c:v", "libx264",           # 재인코딩 (크롭은 copy 불가)
                "-crf", "23",                # 화질 (18=고화질, 28=저화질, 23=기본)
                "-preset", "fast",
                "-c:a", "aac",
                "-avoid_negative_ts", "make_zero",
                clip_path,
            ]
        else:
            # 일반 구간 자르기 (스트림 복사 → 즉시, 색 공간 메타데이터 태깅)
            cmd = [
                ffmpeg_exe,
                "-y",
                "-ss", str(start),
                "-i", raw_path,
                "-t", str(duration),
                "-c:v", "copy",
                "-c:a", "copy",
                "-colorspace", "bt709",
                "-color_trc", "bt709",
                "-color_primaries", "bt709",
                "-avoid_negative_ts", "make_zero",
                clip_path,
            ]

        logger.info(f"✂️ ffmpeg 구간 자르기: {start}s ~ {end}s")
        timeout = max(120, int(duration) + 60)  # 영상 길이 + 여유
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            logger.error(f"ffmpeg stderr: {result.stderr}")
            raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")

        if not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
            raise FileNotFoundError("클립 파일이 생성되지 않았습니다.")

        filename = f"clip_{video_id}_{int(start)}s-{int(end)}s.mp4"
        logger.info(f"✅ 클립 생성 완료: {filename} ({os.path.getsize(clip_path) / 1024 / 1024:.1f}MB)")

        def cleanup():
            import shutil
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass

        background_tasks.add_task(cleanup)

        return FileResponse(
            clip_path,
            media_type="video/mp4",
            filename=filename,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except FileNotFoundError as e:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"❌ 클립 다운로드 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"클립 다운로드에 실패했습니다: {str(e)}")


# ─── 자막 굽기 엔드포인트 ─────────────────────────────────────
from typing import List as TypingList

class SubtitleSegmentModel(BaseModel):
    start: float    # 클립 내 상대 시간 (초)
    end: float
    text: str

class SubtitleStyleModel(BaseModel):
    fontSize: int = 28
    bold: bool = True
    color: str = "white"       # white | yellow | black
    position: str = "bottom"   # top | middle | bottom
    background: bool = False

class BurnSubsRequest(BaseModel):
    url: str
    start: float
    end: float
    quality: str = "720"       # 360|480|720|1080|best|vertical
    subtitle_segments: TypingList[SubtitleSegmentModel]
    style: SubtitleStyleModel = SubtitleStyleModel()

def _srt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    ms = int((sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{int(sec):02d},{ms:03d}"

@app.post("/clip-burn")
async def clip_with_burned_subs(request: BurnSubsRequest, background_tasks: BackgroundTasks):
    """
    구간을 자르고 자막을 영상에 직접 구워 MP4로 반환합니다.
    - POST body: url, start, end, quality, subtitle_segments, style
    """
    video_id = extract_video_id(request.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")
    if request.end <= request.start:
        raise HTTPException(status_code=400, detail="종료 시간이 시작 시간보다 커야 합니다.")
    if not request.subtitle_segments:
        raise HTTPException(status_code=400, detail="자막 데이터가 없습니다.")

    temp_dir = tempfile.mkdtemp()
    raw_path  = os.path.join(temp_dir, f"raw_{video_id}.mp4")
    srt_path  = os.path.join(temp_dir, "subs.srt")
    clip_path = os.path.join(temp_dir, f"burned_{video_id}_{int(request.start)}s-{int(request.end)}s.mp4")

    try:
        # ── 1단계: SRT 파일 생성 ──────────────────────────────────
        srt_lines = []
        for i, seg in enumerate(request.subtitle_segments, 1):
            if seg.text.strip():
                srt_lines.append(
                    f"{i}\n{_srt_time(seg.start)} --> {_srt_time(seg.end)}\n{seg.text.strip()}\n"
                )
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write("\n".join(srt_lines))
        logger.info(f"📝 SRT 생성: {len(srt_lines)}개 자막")

        # ── 2단계: yt-dlp 다운로드 ───────────────────────────────
        q = request.quality if request.quality != "vertical" else "720"
        QMAP = {
            "360":  "bestvideo[vcodec^=avc1][height<=360]+bestaudio[acodec^=mp4a]/best[height<=360]/best",
            "480":  "bestvideo[vcodec^=avc1][height<=480]+bestaudio[acodec^=mp4a]/best[height<=480]/best",
            "720":  "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/best[height<=720]/best",
            "1080": "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/best[height<=1080]/best",
            "best": "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best",
        }
        ydl_opts = {
            "format": QMAP.get(q, QMAP["720"]),
            "merge_output_format": "mp4",
            "outtmpl": raw_path,
            "quiet": True,
            "no_warnings": True,
        }
        if FFMPEG_PATH:
            ydl_opts["ffmpeg_location"] = os.path.dirname(FFMPEG_PATH)

        logger.info(f"🎬 영상 다운로드 시작: {video_id}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([request.url])

        if not os.path.exists(raw_path):
            candidates = glob.glob(os.path.join(temp_dir, f"raw_{video_id}.*"))
            if not candidates:
                raise FileNotFoundError("다운로드된 영상 파일을 찾을 수 없습니다.")
            raw_path = candidates[0]

        # ── 3단계: ffmpeg 자막 굽기 ──────────────────────────────
        st = request.style
        # ffmpeg ASS 색상 형식: &HAABBGGRR (알파=00 불투명)
        COLOR_MAP   = {"white": "&H00FFFFFF", "yellow": "&H0000FFFF", "black": "&H00000000"}
        OUTLINE_MAP = {"white": "&H00000000", "yellow": "&H00000000", "black": "&H00FFFFFF"}
        ALIGN_MAP   = {"top": 8, "middle": 5, "bottom": 2}

        color       = COLOR_MAP.get(st.color, "&H00FFFFFF")
        outline_col = OUTLINE_MAP.get(st.color, "&H00000000")
        alignment   = ALIGN_MAP.get(st.position, 2)
        bold        = 1 if st.bold else 0
        border_style = 4 if st.background else 1

        force_style = (
            f"FontSize={st.fontSize},Bold={bold},"
            f"PrimaryColour={color},OutlineColour={outline_col},"
            f"Outline=2,Shadow=0,Alignment={alignment},MarginV=25,"
            f"BorderStyle={border_style}"
        )
        if st.background:
            force_style += ",BackColour=&H80000000"

        # Windows 경로에서 ffmpeg subtitles 필터용 이스케이프
        srt_esc = srt_path.replace("\\", "/").replace(":", "\\:")

        # vf 필터 조합 (세로 크롭 → 자막 순서)
        vf_filters = []
        if request.quality == "vertical":
            vf_filters.append("crop=ih*9/16:ih")
        vf_filters.append(f"subtitles='{srt_esc}':force_style='{force_style}'")
        vf = ",".join(vf_filters)

        ffmpeg_exe = FFMPEG_PATH if FFMPEG_PATH else "ffmpeg"
        duration   = request.end - request.start

        cmd = [
            ffmpeg_exe, "-y",
            "-ss", str(request.start),
            "-i", raw_path,
            "-t", str(duration),
            "-vf", vf,
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-colorspace", "bt709",
            "-color_trc", "bt709",
            "-color_primaries", "bt709",
            "-c:a", "aac",
            "-avoid_negative_ts", "make_zero",
            clip_path,
        ]

        logger.info(f"🔥 자막 굽기 시작 | 폰트={st.fontSize} 위치={st.position} 색={st.color}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            logger.error(f"ffmpeg stderr: {result.stderr[-500:]}")
            raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")

        if not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
            raise FileNotFoundError("클립 파일이 생성되지 않았습니다.")

        filename = f"burned_{video_id}_{int(request.start)}s-{int(request.end)}s.mp4"
        logger.info(f"✅ 자막 굽기 완료: {filename} ({os.path.getsize(clip_path)/1024/1024:.1f}MB)")

        def cleanup():
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)

        background_tasks.add_task(cleanup)
        return FileResponse(
            clip_path, media_type="video/mp4", filename=filename,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except Exception as e:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"❌ 자막 굽기 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"자막 굽기에 실패했습니다: {str(e)}")


# ─── YouTube 영상 편집(크롭/자막가리기) 다운로드 엔드포인트 ─────────

class ClipEditRequest(BaseModel):
    url: str                   # YouTube URL
    start: float = 0
    end: float = 0             # 0이면 전체
    quality: str = "720"
    # 출력 해상도 (0이면 크롭 크기 사용)
    output_w: int = 0
    output_h: int = 0
    # 크롭 영역 (% 기준, 원본 영상 기준)
    crop_x: float = 0
    crop_y: float = 0
    crop_w: float = 100
    crop_h: float = 100
    # 자막 가리기 (% 기준, 원본 영상 기준)
    cover_enabled: bool = False
    cover_x: float = 5
    cover_y: float = 83
    cover_w: float = 90
    cover_h: float = 12
    cover_color: str = "#000000"
    cover_opacity: float = 0.92
    cover_mode: str = "color"  # 'color' | 'mosaic'
    cover_blur: int = 12       # blur/pixel strength (1-30)
    cover_mosaic_style: str = "blur"  # 'blur' | 'pixel'

@app.post("/clip-edit")
async def clip_edit(request: ClipEditRequest, background_tasks: BackgroundTasks):
    """
    YouTube 영상을 다운로드한 뒤 crop → scale+pad → drawbox(자막가리기)를 적용하여 MP4로 반환합니다.
    화면에서 보이는 그대로 다운로드됩니다.
    """
    video_id = extract_video_id(request.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")

    temp_dir = tempfile.mkdtemp()
    raw_path = os.path.join(temp_dir, f"raw_{video_id}.mp4")
    clip_path = os.path.join(temp_dir, f"edited_{video_id}.mp4")

    try:
        # ── 1단계: yt-dlp 다운로드 ───────────────────────────────
        QMAP = {
            "360":  "bestvideo[vcodec^=avc1][height<=360]+bestaudio[acodec^=mp4a]/best[height<=360]/best",
            "480":  "bestvideo[vcodec^=avc1][height<=480]+bestaudio[acodec^=mp4a]/best[height<=480]/best",
            "720":  "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/best[height<=720]/best",
            "1080": "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/best[height<=1080]/best",
            "best": "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best",
        }
        ydl_opts = {
            "format": QMAP.get(request.quality, QMAP["720"]),
            "merge_output_format": "mp4",
            "outtmpl": raw_path,
            "quiet": True,
            "no_warnings": True,
        }
        if FFMPEG_PATH:
            ydl_opts["ffmpeg_location"] = os.path.dirname(FFMPEG_PATH)

        logger.info(f"🎬 YouTube 편집 다운로드 시작: {video_id}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([request.url])

        if not os.path.exists(raw_path):
            candidates = glob.glob(os.path.join(temp_dir, f"raw_{video_id}.*"))
            if not candidates:
                raise FileNotFoundError("다운로드된 영상 파일을 찾을 수 없습니다.")
            raw_path = candidates[0]

        # ── 2단계: ffprobe로 원본 해상도 ─────────────────────────
        ffmpeg_exe = FFMPEG_PATH if FFMPEG_PATH else "ffmpeg"
        probe_exe = FFPROBE_PATH if FFPROBE_PATH and os.path.exists(FFPROBE_PATH) else "ffprobe"
        probe_cmd = [
            probe_exe, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            raw_path,
        ]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        if probe_result.returncode != 0:
            raise RuntimeError(f"ffprobe 오류: {probe_result.stderr}")
        dims = probe_result.stdout.strip().split("x")
        src_w, src_h = int(dims[0]), int(dims[1])
        logger.info(f"📐 원본 해상도: {src_w}x{src_h}")

        # ── 3단계: vf 필터 구성 (crop → scale+pad → drawbox) ────
        vf_filters = []

        # 크롭
        has_crop = (request.crop_w < 100 or request.crop_h < 100 or
                    request.crop_x > 0 or request.crop_y > 0)
        if has_crop:
            cx = int(src_w * request.crop_x / 100)
            cy = int(src_h * request.crop_y / 100)
            cw = int(src_w * request.crop_w / 100)
            ch = int(src_h * request.crop_h / 100)
            cw = cw - (cw % 2)
            ch = ch - (ch % 2)
            vf_filters.append(f"crop={cw}:{ch}:{cx}:{cy}")
            logger.info(f"✂️ 크롭: {cw}x{ch}+{cx}+{cy}")
            cropped_w, cropped_h = cw, ch
        else:
            cropped_w, cropped_h = src_w, src_h

        # scale+pad
        out_w = request.output_w if request.output_w > 0 else cropped_w
        out_h = request.output_h if request.output_h > 0 else cropped_h
        out_w = out_w - (out_w % 2)
        out_h = out_h - (out_h % 2)

        needs_resize = (out_w != cropped_w or out_h != cropped_h)
        if needs_resize:
            vf_filters.append(f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease")
            vf_filters.append(f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black")
            logger.info(f"📏 출력 해상도: {out_w}x{out_h} (letterbox)")

        # drawbox (자막가리기)
        if request.cover_enabled:
            raw_cx = src_w * request.cover_x / 100
            raw_cy = src_h * request.cover_y / 100
            raw_cw = src_w * request.cover_w / 100
            raw_ch = src_h * request.cover_h / 100
            crop_px = src_w * request.crop_x / 100
            crop_py = src_h * request.crop_y / 100
            rel_cx = raw_cx - crop_px
            rel_cy = raw_cy - crop_py
            if needs_resize:
                scale_ratio = min(out_w / cropped_w, out_h / cropped_h)
                scaled_w = cropped_w * scale_ratio
                scaled_h = cropped_h * scale_ratio
                pad_x = (out_w - scaled_w) / 2
                pad_y = (out_h - scaled_h) / 2
            else:
                scale_ratio = 1.0
                pad_x = 0
                pad_y = 0
            bx = int(pad_x + rel_cx * scale_ratio)
            by = int(pad_y + rel_cy * scale_ratio)
            bw = int(raw_cw * scale_ratio)
            bh = int(raw_ch * scale_ratio)
            bx = max(0, min(bx, out_w - 1))
            by = max(0, min(by, out_h - 1))
            bw = max(1, min(bw, out_w - bx))
            bh = max(1, min(bh, out_h - by))
            if request.cover_mode == 'mosaic':
                blur_val = max(1, min(30, request.cover_blur))
                if request.cover_mosaic_style == 'pixel':
                    factor = max(2, blur_val)
                    mosaic_vf = f"crop={bw}:{bh}:{bx}:{by},scale=iw/{factor}:ih/{factor},scale={bw}:{bh}:flags=neighbor"
                else:
                    mosaic_vf = f"crop={bw}:{bh}:{bx}:{by},avgblur=sizeX={blur_val}:sizeY={blur_val}"
                vf_filters.append(f"__MOSAIC__|{mosaic_vf}|{bx}|{by}")
                logger.info(f"🔲 모자이크({request.cover_mosaic_style}) 가리기: {bw}x{bh}+{bx}+{by} 강도={blur_val}")
            else:
                color_hex = request.cover_color.lstrip("#")
                opacity = round(request.cover_opacity, 2)
                color_str = f"0x{color_hex}@{opacity}"
                vf_filters.append(f"drawbox=x={bx}:y={by}:w={bw}:h={bh}:color={color_str}:t=fill")
                logger.info(f"🟫 자막가리기: {bw}x{bh}+{bx}+{by} color={color_str}")

        # ── 4단계: ffmpeg 실행 ────────────────────────────────────
        cmd = [ffmpeg_exe, "-y"]
        if request.start > 0:
            cmd += ["-ss", str(request.start)]
        cmd += ["-i", raw_path]
        if request.end > 0 and request.end > request.start:
            cmd += ["-t", str(request.end - request.start)]

        duration = (request.end - request.start) if request.end > request.start else 600
        timeout = max(300, int(duration) + 120)

        has_mosaic = any(f.startswith('__MOSAIC__|') for f in vf_filters)
        if vf_filters:
            if has_mosaic:
                pre_filters = [f for f in vf_filters if not f.startswith('__MOSAIC__|')]
                mosaic_entry = [f for f in vf_filters if f.startswith('__MOSAIC__|')][0]
                parts = mosaic_entry.split('|', 3)
                mosaic_vf = parts[1]
                m_bx = parts[2]
                m_by = parts[3]
                # 2단계 처리: 1) pre_filters → 중간 파일  2) mosaic → 최종 파일
                if pre_filters:
                    mid_path = clip_path.replace('.mp4', '_mid.mp4')
                    cmd1 = cmd + ["-vf", ",".join(pre_filters), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-avoid_negative_ts", "make_zero", mid_path]
                    logger.info(f"🎬 1단계(pre): {' '.join(cmd1)}")
                    r1 = subprocess.run(cmd1, capture_output=True, text=True, timeout=timeout)
                    if r1.returncode != 0:
                        raise RuntimeError(f"ffmpeg pre-filter 오류: {r1.stderr[-300:]}")
                    mosaic_fc = f"[0:v]split=2[a][b];[b]{mosaic_vf}[blr];[a][blr]overlay={m_bx}:{m_by}[vout]"
                    cmd2 = [ffmpeg_exe, "-y", "-i", mid_path, "-filter_complex", mosaic_fc, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", clip_path]
                    logger.info(f"🎬 2단계(mosaic): {' '.join(cmd2)}")
                    r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=timeout)
                    if r2.returncode != 0:
                        logger.error(f"ffmpeg mosaic stderr: {r2.stderr}")
                        raise RuntimeError(f"ffmpeg mosaic 오류: {r2.stderr[-300:]}")
                    # 중간 파일 삭제
                    try: os.remove(mid_path)
                    except: pass
                else:
                    mosaic_fc = f"[0:v]split=2[a][b];[b]{mosaic_vf}[blr];[a][blr]overlay={m_bx}:{m_by}[vout]"
                    cmd += ["-filter_complex", mosaic_fc, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
                    logger.info(f"🎬 편집 시작(mosaic): {' '.join(cmd)}")
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                    if result.returncode != 0:
                        logger.error(f"ffmpeg stderr: {result.stderr}")
                        raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")
            else:
                cmd += ["-vf", ",".join(vf_filters), "-c:v", "libx264", "-crf", "18", "-preset", "fast"]
                cmd += ["-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
                logger.info(f"🎬 YouTube 편집 시작: {' '.join(cmd)}")
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                if result.returncode != 0:
                    logger.error(f"ffmpeg stderr: {result.stderr[-500:]}")
                    raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")
        else:
            cmd += ["-c:v", "copy", "-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
            logger.info(f"🎬 YouTube 편집 시작: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode != 0:
                logger.error(f"ffmpeg stderr: {result.stderr[-500:]}")
                raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")




        if not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
            raise FileNotFoundError("편집된 클립 파일이 생성되지 않았습니다.")

        filename = f"edited_{video_id}.mp4"
        logger.info(f"✅ YouTube 편집 완료: {filename} ({os.path.getsize(clip_path)/1024/1024:.1f}MB)")

        def cleanup():
            import shutil as _shutil
            _shutil.rmtree(temp_dir, ignore_errors=True)

        background_tasks.add_task(cleanup)
        return FileResponse(
            clip_path, media_type="video/mp4", filename=filename,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except Exception as e:
        import shutil as _shutil
        _shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"❌ YouTube 편집 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"YouTube 편집에 실패했습니다: {str(e)}")

# ─── 로컬 영상 편집(크롭/자막가리기) 엔드포인트 ────────────────────
from typing import Optional

class LocalClipRequest(BaseModel):
    media_path: str            # /uploads/xxx.mp4
    start: float = 0
    end: float = 0             # 0이면 전체
    # 출력 해상도 (직접 지정, 0이면 원본)
    output_w: int = 0
    output_h: int = 0
    # 크롭 영역 (% 기준, 원본 영상 기준)
    crop_x: float = 0
    crop_y: float = 0
    crop_w: float = 100
    crop_h: float = 100
    # 자막 가리기 (% 기준, 출력 프레임 기준)
    cover_enabled: bool = False
    cover_x: float = 5
    cover_y: float = 83
    cover_w: float = 90
    cover_h: float = 12
    cover_color: str = "#000000"
    cover_opacity: float = 0.92
    cover_mode: str = "color"  # 'color' | 'mosaic'
    cover_blur: int = 12
    cover_mosaic_style: str = "blur"  # 'blur' | 'pixel'
    video_scale: float = 1.0     # 영상 축소 비율 (0.1~2.0+)
    cover_is_canvas_pct: bool = False  # True면 cover 좌표를 출력 캔버스 % 그대로 사용
    pan_x: float = 0.0  # 드래그 오프셋 X (캔버스 %, 0=중앙)
    pan_y: float = 0.0  # 드래그 오프셋 Y (캔버스 %, 0=중앙)

@app.post("/clip-local")
async def clip_local(request: LocalClipRequest, background_tasks: BackgroundTasks):
    """
    로컬 업로드 영상을 crop → scale+pad → drawbox(자막가리기) 순서로 처리합니다.
    화면에서 보이는 그대로 다운로드됩니다.
    """
    # 미디어 파일 경로 확인
    rel = request.media_path.lstrip("/")
    src_path = str(BASE_DIR / rel)
    if not os.path.exists(src_path):
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {request.media_path}")

    temp_dir = tempfile.mkdtemp()
    clip_path = os.path.join(temp_dir, "edited_clip.mp4")

    try:
        ffmpeg_exe = FFMPEG_PATH if FFMPEG_PATH else "ffmpeg"

        # ffprobe로 원본 해상도 가져오기
        probe_exe = FFPROBE_PATH if FFPROBE_PATH and os.path.exists(FFPROBE_PATH) else "ffprobe"
        probe_cmd = [
            probe_exe, "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            src_path,
        ]
        probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
        if probe_result.returncode != 0:
            raise RuntimeError(f"ffprobe 오류: {probe_result.stderr}")
        dims = probe_result.stdout.strip().split("x")
        src_w, src_h = int(dims[0]), int(dims[1])
        logger.info(f"📐 원본 해상도: {src_w}x{src_h}")

        vf_filters = []

        # ── 1단계: 크롭 (원본에서 선택 영역만 잘라냄) ──
        # 크롭 요청 좌표 (음수 또는 영상 밖 가능)
        req_cx = int(src_w * request.crop_x / 100)
        req_cy = int(src_h * request.crop_y / 100)
        req_cw = int(src_w * request.crop_w / 100)
        req_ch = int(src_h * request.crop_h / 100)

        has_crop = (request.crop_w < 100 or request.crop_h < 100 or
                    request.crop_x > 0 or request.crop_y > 0 or
                    request.crop_x < 0 or request.crop_y < 0 or
                    request.crop_w > 100 or request.crop_h > 100)

        if has_crop:
            # 영상과 크롭의 교차 영역 계산
            ix1 = max(0, req_cx)
            iy1 = max(0, req_cy)
            ix2 = min(src_w, req_cx + req_cw)
            iy2 = min(src_h, req_cy + req_ch)
            iw = ix2 - ix1
            ih = iy2 - iy1

            # 크롭이 영상 안에만 있는 경우 (일반 크롭)
            extends_beyond = (req_cx < 0 or req_cy < 0 or
                              req_cx + req_cw > src_w or req_cy + req_ch > src_h)

            if iw > 0 and ih > 0:
                iw = max(2, iw - (iw % 2))
                ih = max(2, ih - (ih % 2))
                vf_filters.append(f"crop={iw}:{ih}:{ix1}:{iy1}")

                if extends_beyond:
                    # 크롭이 영상 밖으로 확장 → 교차 부분 크롭 후 패딩
                    pad_x = ix1 - req_cx  # 영상 콘텐츠의 출력 내 위치
                    pad_y = iy1 - req_cy
                    pad_w = max(2, req_cw - (req_cw % 2))
                    pad_h = max(2, req_ch - (req_ch % 2))
                    vf_filters.append(f"pad={pad_w}:{pad_h}:{pad_x}:{pad_y}:black")
                    logger.info(f"✂️ 크롭+패드: crop={iw}x{ih}+{ix1}+{iy1} → pad={pad_w}x{pad_h}+{pad_x}+{pad_y}")
                    cropped_w, cropped_h = pad_w, pad_h
                else:
                    logger.info(f"✂️ 크롭: {iw}x{ih}+{ix1}+{iy1}")
                    cropped_w, cropped_h = iw, ih
            else:
                # 교차 없음 → 전체 검은 프레임
                pad_w = max(2, req_cw - (req_cw % 2))
                pad_h = max(2, req_ch - (req_ch % 2))
                vf_filters.append(f"scale=2:2")
                vf_filters.append(f"pad={pad_w}:{pad_h}:{pad_w//2}:{pad_h//2}:black")
                logger.info(f"✂️ 교차 없음: 검은 프레임 {pad_w}x{pad_h}")
                cropped_w, cropped_h = pad_w, pad_h
        else:
            cropped_w, cropped_h = src_w, src_h

        # ── 2단계: 출력 해상도로 scale+pad (letterbox) ──
        out_w = request.output_w if request.output_w > 0 else cropped_w
        out_h = request.output_h if request.output_h > 0 else cropped_h
        # 짝수로 맞추기
        out_w = out_w - (out_w % 2)
        out_h = out_h - (out_h % 2)

        needs_resize = (out_w != cropped_w or out_h != cropped_h)
        vs = max(0.1, request.video_scale)  # 상한 제거 — 확대 허용

        if needs_resize or vs != 1.0:
            # 영상을 출력 캔버스에 맞추는 기본 비율 계산
            fit_ratio = min(out_w / cropped_w, out_h / cropped_h)
            # video_scale 적용
            final_ratio = fit_ratio * vs
            final_w = int(cropped_w * final_ratio)
            final_h = int(cropped_h * final_ratio)
            # 짝수로 맞추기
            final_w = final_w - (final_w % 2)
            final_h = final_h - (final_h % 2)
            # 최소 2px
            final_w = max(2, final_w)
            final_h = max(2, final_h)

            vf_filters.append(f"scale={final_w}:{final_h}")

            # 초과하는 부분은 crop, 부족한 부분은 pad (둘 다 적용 가능)
            need_crop = (final_w > out_w or final_h > out_h)
            need_pad = (final_w < out_w or final_h < out_h)

            if need_crop:
                crop_cw = min(final_w, out_w)
                crop_ch = min(final_h, out_h)
                # 팬 오프셋 적용 (캔버스 % → 픽셀)
                # pan_x > 0 → 영상이 오른쪽으로 이동 → crop 왼쪽으로 이동
                pan_px_x = int(final_w * request.pan_x / 100)
                pan_px_y = int(final_h * request.pan_y / 100)
                # 기본 중앙 크롭 위치에서 팬 오프셋 적용
                cx = (final_w - crop_cw) // 2 - pan_px_x
                cy = (final_h - crop_ch) // 2 - pan_px_y
                # 범위 클램핑
                cx = max(0, min(cx, final_w - crop_cw))
                cy = max(0, min(cy, final_h - crop_ch))
                vf_filters.append(f"crop={crop_cw}:{crop_ch}:{cx}:{cy}")
                logger.info(f"✂️ 크롭: {crop_cw}x{crop_ch}+{cx}+{cy} (pan={request.pan_x:.1f},{request.pan_y:.1f}%)")
            if need_pad:
                vf_filters.append(f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black")

            logger.info(f"📏 출력: {out_w}x{out_h} (scale={final_w}x{final_h}, vs={int(vs*100)}%)")

        # ── 3단계: 자막 가리기 (drawbox) ──
        if request.cover_enabled:
            if request.cover_is_canvas_pct:
                # 캔버스 모드: 좌표가 출력 캔버스 % 그대로
                bx = int(out_w * request.cover_x / 100)
                by = int(out_h * request.cover_y / 100)
                bw = int(out_w * request.cover_w / 100)
                bh = int(out_h * request.cover_h / 100)
            else:
                # 레거시: 원본 영상 기준 % → crop+scale+pad 후 최종 좌표로 변환
                raw_cx = src_w * request.cover_x / 100
                raw_cy = src_h * request.cover_y / 100
                raw_cw = src_w * request.cover_w / 100
                raw_ch = src_h * request.cover_h / 100

                crop_px = src_w * request.crop_x / 100
                crop_py = src_h * request.crop_y / 100
                rel_cx = raw_cx - crop_px
                rel_cy = raw_cy - crop_py

                if needs_resize:
                    scale_ratio = min(out_w / cropped_w, out_h / cropped_h)
                    scaled_w = cropped_w * scale_ratio
                    scaled_h = cropped_h * scale_ratio
                    pad_x = (out_w - scaled_w) / 2
                    pad_y = (out_h - scaled_h) / 2
                else:
                    scale_ratio = 1.0
                    pad_x = 0
                    pad_y = 0

                bx = int(pad_x + rel_cx * scale_ratio)
                by = int(pad_y + rel_cy * scale_ratio)
                bw = int(raw_cw * scale_ratio)
                bh = int(raw_ch * scale_ratio)

            # 경계 클램핑
            bx = max(0, min(bx, out_w - 1))
            by = max(0, min(by, out_h - 1))
            bw = max(1, min(bw, out_w - bx))
            bh = max(1, min(bh, out_h - by))

            if request.cover_mode == 'mosaic':
                blur_val = max(1, min(30, request.cover_blur))
                if request.cover_mosaic_style == 'pixel':
                    factor = max(2, blur_val)
                    mosaic_vf = f"crop={bw}:{bh}:{bx}:{by},scale=iw/{factor}:ih/{factor},scale={bw}:{bh}:flags=neighbor"
                else:
                    mosaic_vf = f"crop={bw}:{bh}:{bx}:{by},avgblur=sizeX={blur_val}:sizeY={blur_val}"
                vf_filters.append(f"__MOSAIC__|{mosaic_vf}|{bx}|{by}")
                logger.info(f"🔲 모자이크({request.cover_mosaic_style}) 가리기: {bw}x{bh}+{bx}+{by} 강도={blur_val}")
            else:
                color_hex = request.cover_color.lstrip("#")
                opacity = round(request.cover_opacity, 2)
                color_str = f"0x{color_hex}@{opacity}"
                vf_filters.append(f"drawbox=x={bx}:y={by}:w={bw}:h={bh}:color={color_str}:t=fill")
                logger.info(f"🟫 자막가리기: {bw}x{bh}+{bx}+{by} color={color_str}")

        # 시작/끝 시간 계산
        cmd = [ffmpeg_exe, "-y"]
        if request.start > 0:
            cmd += ["-ss", str(request.start)]
        cmd += ["-i", src_path]
        if request.end > 0 and request.end > request.start:
            cmd += ["-t", str(request.end - request.start)]

        duration = (request.end - request.start) if request.end > request.start else 600
        timeout = max(120, int(duration) + 60)

        has_mosaic = any(f.startswith('__MOSAIC__|') for f in vf_filters)
        if vf_filters:
            if has_mosaic:
                pre_filters = [f for f in vf_filters if not f.startswith('__MOSAIC__|')]
                mosaic_entry = [f for f in vf_filters if f.startswith('__MOSAIC__|')][0]
                parts = mosaic_entry.split('|', 3)
                mosaic_vf = parts[1]
                m_bx = parts[2]
                m_by = parts[3]
                if pre_filters:
                    mid_path = clip_path.replace('.mp4', '_mid.mp4')
                    cmd1 = cmd + ["-vf", ",".join(pre_filters), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-avoid_negative_ts", "make_zero", mid_path]
                    logger.info(f"🎬 1단계(pre): {' '.join(cmd1)}")
                    r1 = subprocess.run(cmd1, capture_output=True, text=True, timeout=timeout)
                    if r1.returncode != 0:
                        raise RuntimeError(f"ffmpeg pre-filter 오류: {r1.stderr[-300:]}")
                    mosaic_fc = f"[0:v]split=2[a][b];[b]{mosaic_vf}[blr];[a][blr]overlay={m_bx}:{m_by}[vout]"
                    cmd2 = [ffmpeg_exe, "-y", "-i", mid_path, "-filter_complex", mosaic_fc, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", clip_path]
                    logger.info(f"🎬 2단계(mosaic): {' '.join(cmd2)}")
                    r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=timeout)
                    if r2.returncode != 0:
                        logger.error(f"ffmpeg mosaic stderr: {r2.stderr}")
                        raise RuntimeError(f"ffmpeg mosaic 오류: {r2.stderr[-300:]}")
                    try: os.remove(mid_path)
                    except: pass
                else:
                    mosaic_fc = f"[0:v]split=2[a][b];[b]{mosaic_vf}[blr];[a][blr]overlay={m_bx}:{m_by}[vout]"
                    cmd += ["-filter_complex", mosaic_fc, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
                    logger.info(f"🎬 편집 시작(mosaic): {' '.join(cmd)}")
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                    if result.returncode != 0:
                        logger.error(f"ffmpeg stderr: {result.stderr}")
                        raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")
            else:
                cmd += ["-vf", ",".join(vf_filters), "-c:v", "libx264", "-crf", "18", "-preset", "fast"]
                cmd += ["-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
                logger.info(f"🎬 로컬 편집 시작: {' '.join(cmd)}")
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
                if result.returncode != 0:
                    logger.error(f"ffmpeg stderr: {result.stderr[-500:]}")
                    raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")
        else:
            cmd += ["-c:v", "copy", "-c:a", "aac", "-avoid_negative_ts", "make_zero", clip_path]
            logger.info(f"🎬 로컬 편집 시작: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode != 0:
                logger.error(f"ffmpeg stderr: {result.stderr[-500:]}")
                raise RuntimeError(f"ffmpeg 오류: {result.stderr[-300:]}")




        if not os.path.exists(clip_path) or os.path.getsize(clip_path) == 0:
            raise FileNotFoundError("편집된 클립 파일이 생성되지 않았습니다.")

        filename = f"edited_{Path(request.media_path).stem}.mp4"
        logger.info(f"✅ 로컬 편집 완료: {filename} ({os.path.getsize(clip_path)/1024/1024:.1f}MB)")

        def cleanup():
            import shutil as _shutil
            _shutil.rmtree(temp_dir, ignore_errors=True)

        background_tasks.add_task(cleanup)
        return FileResponse(
            clip_path, media_type="video/mp4", filename=filename,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    except Exception as e:
        import shutil as _shutil
        _shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"❌ 로컬 편집 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"로컬 편집에 실패했습니다: {str(e)}")

# ─── 로컬 파일 업로드 엔드포인트 ──────────────────────────────────
from fastapi import UploadFile, File
from fastapi.staticfiles import StaticFiles
import shutil
import uuid

# 업로드 파일 임시 저장 디렉토리
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# 정적 파일 서빙 (업로드된 미디어 파일 접근용)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

def _get_audio_duration(file_path: str) -> float:
    """ffprobe로 오디오/비디오 파일의 총 재생 시간(초)을 반환. 실패 시 0."""
    try:
        probe_exe = FFPROBE_PATH if FFPROBE_PATH and os.path.exists(FFPROBE_PATH) else "ffprobe"
        cmd = [
            probe_exe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(file_path),
        ]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


@app.post("/upload-transcribe")
async def upload_and_transcribe(
    file: UploadFile = File(...),
    model: str = Query("base", description="Whisper 모델: tiny, base, small, medium, large")
):
    """
    로컬 영상/음성 파일을 업로드하여 Whisper로 전사합니다.
    지원 형식: mp4, webm, mp3, wav, m4a, ogg, flac
    지원 모델: tiny, base, small, medium, large
    """
    if whisper is None:
        raise HTTPException(status_code=500, detail="Whisper가 설치되지 않았습니다. pip install openai-whisper")

    # 확장자 검증
    ext = Path(file.filename).suffix.lower() if file.filename else ""
    allowed = {".mp4", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".mkv", ".avi"}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 파일 형식입니다: {ext}")

    # 고유 ID 생성
    file_id = str(uuid.uuid4())[:8]
    safe_name = f"{file_id}{ext}"

    try:
        # 파일 저장
        file_path = UPLOAD_DIR / safe_name
        with open(file_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        logger.info(f"📁 파일 업로드 완료: {file.filename} → {safe_name} ({file_path.stat().st_size / 1024 / 1024:.1f}MB)")

        # Whisper 전사
        allowed_models = {"tiny", "base", "small", "medium", "large"}
        model_name = model if model in allowed_models else "base"
        logger.info(f"🎤 Whisper 전사 시작... (모델: {model_name})")
        whisper_model = whisper.load_model(model_name)
        result = whisper_model.transcribe(str(file_path))

        segments = [{
            "start": seg["start"],
            "duration": seg["end"] - seg["start"],
            "text": seg["text"]
        } for seg in result.get("segments", [])]

        logger.info(f"✅ 전사 완료! {len(segments)}개 세그먼트")

        return {
            "transcript": result["text"],
            "segments": segments,
            "video_id": file_id,
            "method": "whisper",
            "language": result.get("language", "unknown"),
            "media_url": f"/uploads/{safe_name}",
            "filename": file.filename,
        }

    except Exception as e:
        # 실패 시 파일 정리
        if file_path.exists():
            file_path.unlink()
        logger.error(f"❌ 로컬 파일 전사 실패: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"전사에 실패했습니다: {str(e)}")


@app.post("/upload-transcribe-stream")
async def upload_and_transcribe_stream(
    file: UploadFile = File(...),
    model: str = Query("base", description="Whisper 모델: tiny, base, small, medium, large")
):
    """
    로컬 파일 업로드 + Whisper 전사를 SSE 스트림으로 진행률과 함께 반환합니다.
    이벤트 종류:
      - progress: {"percent": 0~100, "stage": "..."}
      - result:   최종 전사 결과 JSON
      - error:    에러 메시지
    """
    if whisper is None:
        raise HTTPException(status_code=500, detail="Whisper가 설치되지 않았습니다.")

    ext = Path(file.filename).suffix.lower() if file.filename else ""
    allowed = {".mp4", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".mkv", ".avi"}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 파일 형식입니다: {ext}")

    file_id = str(uuid.uuid4())[:8]
    safe_name = f"{file_id}{ext}"
    file_path = UPLOAD_DIR / safe_name
    original_filename = file.filename

    # 파일 저장 (메모리에 먼저 로드 — SSE generator 밖에서 처리)
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)
    file_size_mb = file_path.stat().st_size / 1024 / 1024
    logger.info(f"📁 파일 업로드 완료: {original_filename} → {safe_name} ({file_size_mb:.1f}MB)")

    async def event_generator():
        """SSE 이벤트 생성기"""
        def sse(event: str, data: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        try:
            # ── 1단계: 파일 저장 완료 (10%) ──
            yield sse("progress", {"percent": 10, "stage": "파일 업로드 완료"})

            # ── 2단계: 오디오 길이 분석 (15%) ──
            yield sse("progress", {"percent": 15, "stage": "오디오 분석 중..."})
            total_duration = _get_audio_duration(str(file_path))
            logger.info(f"⏱ 오디오 길이: {total_duration:.1f}초")

            yield sse("progress", {"percent": 20, "stage": "AI 모델 로딩 중..."})
            allowed_models = {"tiny", "base", "small", "medium", "large"}
            model_name = model if model in allowed_models else "base"
            logger.info(f"🎤 Whisper 모델 로딩: {model_name}")
            whisper_model = whisper.load_model(model_name)

            # ── 4단계: 전사 실행 (20%→95%) ──
            yield sse("progress", {"percent": 22, "stage": "음성 인식 중..."})

            # Whisper 전사를 별도 스레드에서 실행하고, 세그먼트 진행률을 폴링
            result_holder = {"result": None, "error": None, "done": False}

            def run_whisper():
                try:
                    result_holder["result"] = whisper_model.transcribe(
                        str(file_path),
                        verbose=True,  # 세그먼트별 로그 출력 (진행 확인용)
                    )
                except Exception as e:
                    result_holder["error"] = str(e)
                finally:
                    result_holder["done"] = True

            thread = threading.Thread(target=run_whisper, daemon=True)
            thread.start()

            # 폴링: Whisper가 완료될 때까지 진행률 업데이트
            last_percent = 22
            poll_interval = 1.5  # 초
            elapsed = 0.0

            while not result_holder["done"]:
                await asyncio.sleep(poll_interval)
                elapsed += poll_interval

                # 진행률 추정: verbose=True일 때 Whisper가 stderr에 출력하지만
                # 직접 캡처는 어려우므로 경과 시간 기반으로 추정
                if total_duration > 0:
                    # Whisper base 모델: 대략 오디오 길이의 0.3~0.5배 시간 소요
                    # 안전하게 0.6배로 추정
                    estimated_total_time = total_duration * 0.6
                    progress_ratio = min(elapsed / estimated_total_time, 0.95)
                else:
                    # duration을 알 수 없으면 천천히 증가
                    progress_ratio = min(elapsed / 600, 0.95)  # 10분 기준

                percent = int(22 + progress_ratio * 73)  # 22% → 95%
                percent = min(percent, 95)

                if percent > last_percent:
                    last_percent = percent
                    minutes = int(elapsed // 60)
                    secs = int(elapsed % 60)
                    time_str = f"{minutes}분 {secs}초" if minutes > 0 else f"{secs}초"
                    yield sse("progress", {
                        "percent": percent,
                        "stage": f"음성 인식 중... ({time_str} 경과)",
                    })

            # 스레드 완료 대기
            thread.join(timeout=5)

            if result_holder["error"]:
                raise Exception(result_holder["error"])

            result = result_holder["result"]
            yield sse("progress", {"percent": 95, "stage": "결과 정리 중..."})

            segments = [{
                "start": seg["start"],
                "duration": seg["end"] - seg["start"],
                "text": seg["text"]
            } for seg in result.get("segments", [])]

            logger.info(f"✅ 전사 완료! {len(segments)}개 세그먼트")

            yield sse("progress", {"percent": 100, "stage": "완료!"})
            yield sse("result", {
                "transcript": result["text"],
                "segments": segments,
                "video_id": file_id,
                "method": "whisper",
                "language": result.get("language", "unknown"),
                "media_url": f"/uploads/{safe_name}",
                "filename": original_filename,
            })

        except Exception as e:
            logger.error(f"❌ 스트리밍 전사 실패: {e}", exc_info=True)
            if file_path.exists():
                file_path.unlink()
            yield sse("error", {"detail": f"전사에 실패했습니다: {str(e)}"})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # nginx 프록시 버퍼링 비활성화
        },
    )

@app.post("/upload-media")
async def upload_media(file: UploadFile = File(...)):
    """
    로컬 영상/음성 파일을 업로드하여 재생 URL을 반환합니다 (전사 없이).
    """
    ext = Path(file.filename).suffix.lower() if file.filename else ""
    allowed = {".mp4", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".mkv", ".avi"}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 파일 형식입니다: {ext}")

    file_id = str(uuid.uuid4())[:8]
    safe_name = f"{file_id}{ext}"
    file_path = UPLOAD_DIR / safe_name

    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    logger.info(f"📁 미디어 업로드: {file.filename} → {safe_name}")
    return {
        "media_url": f"/uploads/{safe_name}",
        "file_id": file_id,
        "filename": file.filename,
    }

# ─── 얼굴 자동감지 블러 ─────────────────────────────────────────────
class BlurFacesRequest(BaseModel):
    media_path: str  # /uploads/xxx.mp4
    start: float = 0
    end: float = 0
    blur_strength: int = 15  # 1-30
    confidence: float = 0.3  # 감지 신뢰도 0.0-1.0
    detection_model: int = 1  # 0=가까운 얼굴, 1=전체 범위
    margin: float = 0.3  # 감지 영역 여백 (30%)
    carry_frames: int = 8  # 감지 누락 시 이전 위치 유지 프레임 수
    smooth_alpha: float = 0.4  # 스무딩 강도 (0=부드러움, 1=즉시반영)

@app.post("/blur-faces")
async def blur_faces(request: BlurFacesRequest, background_tasks: BackgroundTasks):
    """mediapipe를 사용하여 영상 내 얼굴을 자동 감지하고 블러 처리합니다."""
    if cv2 is None or mp is None:
        raise HTTPException(status_code=500, detail="opencv-python, mediapipe가 설치되어 있지 않습니다. pip install opencv-python mediapipe")

    rel = request.media_path.lstrip("/")
    src_path = str(BASE_DIR / rel)
    if not os.path.exists(src_path):
        raise HTTPException(status_code=400, detail=f"파일을 찾을 수 없습니다: {request.media_path}")

    temp_dir = tempfile.mkdtemp()
    video_only_path = os.path.join(temp_dir, "video_blurred.mp4")
    final_path = os.path.join(temp_dir, "face_blurred.mp4")

    try:
        cap = cv2.VideoCapture(src_path)
        if not cap.isOpened():
            raise RuntimeError("영상 파일을 열 수 없습니다.")

        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        start_frame = int(request.start * fps) if request.start > 0 else 0
        end_frame = int(request.end * fps) if request.end > 0 else total_frames

        if start_frame > 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(video_only_path, fourcc, fps, (w, h))

        # mediapipe 얼굴 감지 (Tasks API)
        from mediapipe.tasks.python import vision as mp_vision, BaseOptions as MpBaseOptions
        model_path = str(BASE_DIR / "blaze_face_short_range.tflite")
        if not os.path.exists(model_path):
            # 모델 자동 다운로드
            import urllib.request
            url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
            urllib.request.urlretrieve(url, model_path)
            logger.info(f"🔵 모델 다운로드: {model_path}")

        detector_options = mp_vision.FaceDetectorOptions(
            base_options=MpBaseOptions(model_asset_path=model_path),
            min_detection_confidence=request.confidence
        )
        face_detector = mp_vision.FaceDetector.create_from_options(detector_options)

        blur_k = max(3, request.blur_strength * 6 + 1)  # 커널 크기 (홀수)
        if blur_k % 2 == 0:
            blur_k += 1
        margin = request.margin

        # ── 트래킹 상태 ──
        # tracked_faces: { id: { x1, y1, x2, y2, missed } }
        tracked_faces: dict = {}
        next_face_id = 0
        SMOOTH_ALPHA = max(0.05, min(1.0, request.smooth_alpha))
        CARRY_FRAMES = max(0, min(30, request.carry_frames))
        IOU_THRESHOLD = 0.3  # IoU 매칭 임계값

        def calc_iou(a, b):
            """두 박스의 IoU 계산"""
            ix1 = max(a[0], b[0]); iy1 = max(a[1], b[1])
            ix2 = min(a[2], b[2]); iy2 = min(a[3], b[3])
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            area_a = (a[2] - a[0]) * (a[3] - a[1])
            area_b = (b[2] - b[0]) * (b[3] - b[1])
            union = area_a + area_b - inter
            return inter / union if union > 0 else 0

        frame_idx = start_frame
        processed = 0
        logger.info(f"🔵 얼굴 블러 시작: {src_path} ({start_frame}-{end_frame}, {w}x{h}, {fps}fps)")

        while frame_idx < end_frame:
            ret, frame = cap.read()
            if not ret:
                break

            # RGB 변환 후 감지
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            results = face_detector.detect(mp_image)

            # 현재 프레임 감지 박스 추출
            cur_boxes = []
            if results.detections:
                for detection in results.detections:
                    bb = detection.bounding_box
                    mx_px = int(bb.width * margin)
                    my_px = int(bb.height * margin)
                    x1 = max(0, bb.origin_x - mx_px)
                    y1 = max(0, bb.origin_y - my_px)
                    x2 = min(w, bb.origin_x + bb.width + mx_px)
                    y2 = min(h, bb.origin_y + bb.height + my_px)
                    if x2 > x1 and y2 > y1:
                        cur_boxes.append((x1, y1, x2, y2))

            # IoU 기반 매칭: 기존 추적 얼굴과 현재 감지 박스 매칭
            matched_ids = set()
            matched_boxes = set()
            for fid, fdata in tracked_faces.items():
                best_iou = 0
                best_idx = -1
                prev = (fdata['x1'], fdata['y1'], fdata['x2'], fdata['y2'])
                for i, box in enumerate(cur_boxes):
                    if i in matched_boxes:
                        continue
                    iou = calc_iou(prev, box)
                    if iou > best_iou:
                        best_iou = iou
                        best_idx = i
                if best_iou >= IOU_THRESHOLD and best_idx >= 0:
                    # 매칭 성공 → 스무딩 적용
                    box = cur_boxes[best_idx]
                    fdata['x1'] = int(fdata['x1'] * (1 - SMOOTH_ALPHA) + box[0] * SMOOTH_ALPHA)
                    fdata['y1'] = int(fdata['y1'] * (1 - SMOOTH_ALPHA) + box[1] * SMOOTH_ALPHA)
                    fdata['x2'] = int(fdata['x2'] * (1 - SMOOTH_ALPHA) + box[2] * SMOOTH_ALPHA)
                    fdata['y2'] = int(fdata['y2'] * (1 - SMOOTH_ALPHA) + box[3] * SMOOTH_ALPHA)
                    fdata['missed'] = 0
                    matched_ids.add(fid)
                    matched_boxes.add(best_idx)

            # 매칭 안 된 기존 얼굴 → missed 증가 (캐리 포워드)
            expired = []
            for fid, fdata in tracked_faces.items():
                if fid not in matched_ids:
                    fdata['missed'] += 1
                    if fdata['missed'] > CARRY_FRAMES:
                        expired.append(fid)
            for fid in expired:
                del tracked_faces[fid]

            # 매칭 안 된 새 감지 → 새 추적 ID 부여
            for i, box in enumerate(cur_boxes):
                if i not in matched_boxes:
                    tracked_faces[next_face_id] = {
                        'x1': box[0], 'y1': box[1],
                        'x2': box[2], 'y2': box[3],
                        'missed': 0
                    }
                    next_face_id += 1

            # 모든 추적 얼굴에 블러 적용
            for fdata in tracked_faces.values():
                fx1 = max(0, fdata['x1'])
                fy1 = max(0, fdata['y1'])
                fx2 = min(w, fdata['x2'])
                fy2 = min(h, fdata['y2'])
                if fx2 > fx1 and fy2 > fy1:
                    roi = frame[fy1:fy2, fx1:fx2]
                    blurred = cv2.GaussianBlur(roi, (blur_k, blur_k), 0)
                    frame[fy1:fy2, fx1:fx2] = blurred

            out.write(frame)
            frame_idx += 1
            processed += 1

        cap.release()
        out.release()
        face_detector.close()

        logger.info(f"🔵 얼굴 블러 완료: {processed}프레임 처리")

        # 오디오 결합 (FFmpeg)
        ffmpeg_exe = FFMPEG_PATH if FFMPEG_PATH else "ffmpeg"
        mux_cmd = [ffmpeg_exe, "-y"]
        if request.start > 0:
            mux_cmd += ["-ss", str(request.start)]
        mux_cmd += ["-i", src_path]  # 원본 (오디오 소스)
        mux_cmd += ["-i", video_only_path]  # 블러된 비디오
        if request.end > 0 and request.end > request.start:
            mux_cmd += ["-t", str(request.end - request.start)]
        mux_cmd += ["-map", "1:v", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-shortest", final_path]

        logger.info(f"🔵 오디오 결합: {' '.join(mux_cmd)}")
        mux_result = subprocess.run(mux_cmd, capture_output=True, text=True, timeout=600)
        if mux_result.returncode != 0:
            logger.error(f"ffmpeg mux stderr: {mux_result.stderr[-500:]}")
            raise RuntimeError(f"오디오 결합 실패: {mux_result.stderr[-300:]}")

        if not os.path.exists(final_path) or os.path.getsize(final_path) == 0:
            raise FileNotFoundError("블러 처리된 파일이 생성되지 않았습니다.")

        def iterfile():
            with open(final_path, "rb") as f:
                while chunk := f.read(1024 * 1024):
                    yield chunk

        def cleanup():
            import time; time.sleep(10)
            shutil.rmtree(temp_dir, ignore_errors=True)

        background_tasks.add_task(cleanup)

        safe_name = os.path.basename(src_path).rsplit('.', 1)[0]
        return StreamingResponse(
            iterfile(),
            media_type="video/mp4",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}_face_blur.mp4"'}
        )

    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"얼굴 블러 오류: {e}")
        raise HTTPException(status_code=500, detail=f"로컬 편집에 실패했습니다: {e}")



if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
