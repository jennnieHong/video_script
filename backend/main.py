from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import yt_dlp
import whisper
import os
import re
import tempfile
from pathlib import Path
import logging

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FFmpeg configuration
BASE_DIR = Path(__file__).resolve().parent
FFMPEG_BIN_DIR = str(BASE_DIR / "ffmpeg" / "ffmpeg-8.0.1-essentials_build" / "bin")
FFMPEG_PATH = str(BASE_DIR / "ffmpeg" / "ffmpeg-8.0.1-essentials_build" / "bin" / "ffmpeg.exe")
FFPROBE_PATH = str(BASE_DIR / "ffmpeg" / "ffmpeg-8.0.1-essentials_build" / "bin" / "ffprobe.exe")

# Add FFmpeg to PATH
if FFMPEG_BIN_DIR not in os.environ.get('PATH', ''):
    os.environ['PATH'] = FFMPEG_BIN_DIR + os.pathsep + os.environ.get('PATH', '')
    logger.info(f"Added FFmpeg bin directory to PATH: {FFMPEG_BIN_DIR}")

# Verify FFmpeg exists
if not os.path.exists(FFMPEG_PATH):
    logger.error(f"FFmpeg not found at {FFMPEG_PATH}")
else:
    logger.info(f"FFmpeg found at {FFMPEG_PATH}")

app = FastAPI()

# Enable CORS for React
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class TranscribeRequest(BaseModel):
    url: str

def extract_video_id(url):
    pattern = r'(?:v=|\/)([0-9A-Za-z_-]{11}).*'
    match = re.search(pattern, url)
    return match.group(1) if match else None

@app.post("/transcribe")
async def transcribe(request: TranscribeRequest):
    video_id = extract_video_id(request.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="유효한 유튜브 URL이 아닙니다.")

    logger.info(f"Processing video ID: {video_id} using Whisper STT")
    
    # Use Whisper (STT) for all videos
    try:
        logger.info("Starting Whisper transcription...")
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = os.path.join(temp_dir, "audio")
            logger.info(f"Temporary audio path: {audio_path}")
            
            # yt-dlp options
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
            
            logger.info(f"FFmpeg location: {os.path.dirname(FFMPEG_PATH)}")
            logger.info(f"Starting download with yt-dlp...")
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([request.url])
            
            # audio_path might have extension added by yt-dlp
            actual_audio_path = audio_path + ".mp3"
            logger.info(f"Looking for audio file at: {actual_audio_path}")
            
            if not os.path.exists(actual_audio_path):
                logger.error(f"Audio file not found at {actual_audio_path}")
                # Try without extension
                if os.path.exists(audio_path):
                    actual_audio_path = audio_path
                    logger.info(f"Found audio file without extension: {actual_audio_path}")
                else:
                    raise FileNotFoundError(f"Audio file not found at {actual_audio_path}")
            
            # Load Whisper model (base is a good balance between speed and accuracy)
            logger.info("Loading Whisper model...")
            model = whisper.load_model("base")
            logger.info(f"Transcribing audio file: {actual_audio_path}")
            result = model.transcribe(actual_audio_path)
            
            # Format Whisper segments
            segments = [{
                "start": seg['start'],
                "duration": seg['end'] - seg['start'],
                "text": seg['text']
            } for seg in result.get("segments", [])]
            
            logger.info(f"Transcription complete. Found {len(segments)} segments.")
            return {
                "transcript": result["text"],
                "segments": segments,
                "video_id": video_id,
                "method": "whisper"
            }
            
    except Exception as e:
        logger.error(f"Whisper transcription failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"대사 추출에 실패했습니다: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
