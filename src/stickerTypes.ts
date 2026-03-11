export interface StickerKeyframe {
  time: number;      // 초
  x: number;         // % (0-100)
  y: number;         // % (0-100)
  scale: number;     // 배율 (1.0 = 100%)
  rotation: number;  // 도 (0-360)
  opacity: number;   // 0-1
}

export interface StickerTrack {
  id: string;
  name: string;
  image: string;       // base64 data URL
  startTime: number;   // 활성 시작 (초)
  endTime: number;     // 활성 종료 (초)
  keyframes: StickerKeyframe[];
  segmentVisible: boolean[]; // 키프레임 구간별 가시성 [0번 전, 0→1, 1→2, ..., 마지막 후]
  visible: boolean;    // 트랙 전체 가시성
  color: string;       // 타임라인 색상
}

/** 두 키프레임 사이를 선형 보간 */
export function interpolateKF(kfs: StickerKeyframe[], t: number): StickerKeyframe {
  if (kfs.length === 0) return { time: t, x: 50, y: 50, scale: 1, rotation: 0, opacity: 1 };
  if (kfs.length === 1) return kfs[0];
  if (t <= kfs[0].time) return kfs[0];
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].time <= t && t <= kfs[i + 1].time) {
      const r = (kfs[i + 1].time - kfs[i].time) > 0
        ? (t - kfs[i].time) / (kfs[i + 1].time - kfs[i].time) : 0;
      return {
        time: t,
        x: kfs[i].x + (kfs[i + 1].x - kfs[i].x) * r,
        y: kfs[i].y + (kfs[i + 1].y - kfs[i].y) * r,
        scale: kfs[i].scale + (kfs[i + 1].scale - kfs[i].scale) * r,
        rotation: kfs[i].rotation + (kfs[i + 1].rotation - kfs[i].rotation) * r,
        opacity: kfs[i].opacity + (kfs[i + 1].opacity - kfs[i].opacity) * r,
      };
    }
  }
  return kfs[kfs.length - 1];
}

/** 현재 시간에서 스티커가 보여야 하는지 */
export function isStickerVisible(track: StickerTrack, t: number): boolean {
  if (!track.visible) return false;
  if (t < track.startTime || t > track.endTime) return false;
  if (track.keyframes.length === 0) return true;
  // 구간별 가시성 체크
  const kfs = track.keyframes;
  if (t <= kfs[0].time) return track.segmentVisible[0] ?? true;
  if (t >= kfs[kfs.length - 1].time) return track.segmentVisible[kfs.length] ?? true;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].time <= t && t <= kfs[i + 1].time) {
      return track.segmentVisible[i + 1] ?? true;
    }
  }
  return true;
}

const TRACK_COLORS = ['#c084fc', '#60a5fa', '#34d399', '#fb923c', '#f472b6', '#a78bfa', '#38bdf8'];
let colorIdx = 0;
export function nextTrackColor() { return TRACK_COLORS[colorIdx++ % TRACK_COLORS.length]; }

export function makeTrack(name: string, image: string, videoDuration: number): StickerTrack {
  const color = nextTrackColor();
  const end = videoDuration > 0 ? videoDuration : 30;

  // 자동 키프레임: 영상 전체에 균등 분포
  // 영상 길이에 따라 간격 결정 (4~12개 키프레임)
  const targetCount = Math.max(4, Math.min(12, Math.ceil(end / 5)));
  const interval = end / (targetCount - 1);

  // 기본 위치: 화면 상단 중앙 부근에서 자연스럽게 이동
  // 각 키프레임마다 살짝 다른 위치로 부드러운 드리프트 효과
  const baseX = 38; // 중앙 약간 왼쪽
  const baseY = 8;  // 화면 상단 부근
  const kfs: StickerKeyframe[] = Array.from({ length: targetCount }, (_, i) => {
    const progress = i / (targetCount - 1); // 0 ~ 1
    // sin 파형으로 자연스러운 좌우 흔들림 (±8% 범위)
    const driftX = Math.sin(progress * Math.PI * 2) * 8;
    // 위아래는 약간만 (±3% 범위)
    const driftY = Math.sin(progress * Math.PI) * 3;
    return {
      time: Math.min(end, Math.round(i * interval * 10) / 10),
      x: Math.max(5, Math.min(80, baseX + driftX)),
      y: Math.max(3, Math.min(80, baseY + driftY)),
      scale: 1.0,
      rotation: 0,
      opacity: 1.0,
    };
  });

  // 마지막 키프레임은 정확히 end 시간
  kfs[kfs.length - 1].time = end;

  return {
    id: `track-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name, image, color,
    startTime: 0,
    endTime: end,
    keyframes: kfs,
    segmentVisible: Array(kfs.length + 1).fill(true),
    visible: true,
  };
}
