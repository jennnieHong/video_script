import React, { useRef, useCallback } from 'react';
import type { StickerTrack } from './stickerTypes';

interface Props {
  tracks: StickerTrack[];
  currentTime: number;
  duration: number;         // 영상 전체 길이(초)
  activeTrackId: string | null;
  onSelectTrack: (id: string) => void;
  onUpdateTrack: (id: string, patch: Partial<StickerTrack>) => void;
  onDeleteTrack: (id: string) => void;
  onSeek: (t: number) => void;
  onDeleteKeyframe: (trackId: string, kfIdx: number) => void;
  onToggleSegment: (trackId: string, segIdx: number) => void;
}

const ROW_H = 32;
const HEADER_W = 90;


function xToTime(x: number, duration: number, w: number) {
  return Math.max(0, Math.min(duration, ((x - HEADER_W) / (w - HEADER_W)) * duration));
}

const StickerTimeline: React.FC<Props> = ({
  tracks, currentTime, duration, activeTrackId,
  onSelectTrack, onUpdateTrack, onDeleteTrack,
  onSeek, onDeleteKeyframe, onToggleSegment,
}) => {
  const rulerRef = useRef<HTMLDivElement>(null);

  const handleRulerClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = xToTime(e.clientX - rect.left, duration, rect.width);
    onSeek(t);
  }, [duration, onSeek]);

  const handleDragRange = useCallback((trackId: string, which: 'start' | 'end', e: React.MouseEvent) => {
    e.stopPropagation();
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const onMove = (ev: MouseEvent) => {
      const t = xToTime(ev.clientX - rect.left, duration, rect.width);
      if (which === 'start') {
        onUpdateTrack(trackId, { startTime: Math.min(t, track.endTime - 0.5) });
      } else {
        onUpdateTrack(trackId, { endTime: Math.max(t, track.startTime + 0.5) });
      }
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  }, [tracks, duration, onUpdateTrack]);

  const handleDragKF = useCallback((trackId: string, kfIdx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const ruler = rulerRef.current;
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    const onMove = (ev: MouseEvent) => {
      const t = Math.max(track.startTime, Math.min(track.endTime, xToTime(ev.clientX - rect.left, duration, rect.width)));
      const kfs = [...track.keyframes];
      kfs[kfIdx] = { ...kfs[kfIdx], time: t };
      kfs.sort((a, b) => a.time - b.time);
      onUpdateTrack(trackId, { keyframes: kfs });
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  }, [tracks, duration, onUpdateTrack]);

  if (tracks.length === 0) return null;

  const totalH = tracks.length * ROW_H + 20; // 20 = ruler

  return (
    <div style={{ background: '#0f172a', borderTop: '1px solid rgba(255,255,255,0.07)', borderBottom: '1px solid rgba(255,255,255,0.07)', userSelect: 'none' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)', gap: 6, background: '#0a0f1e' }}>
        <span style={{ fontSize: '0.55rem', color: '#64748b', fontWeight: 600, letterSpacing: 1 }}>스티커 타임라인</span>
      </div>

      {/* 타임라인 본체 */}
      <div ref={rulerRef} style={{ position: 'relative', height: totalH, overflow: 'hidden' }}
        onClick={handleRulerClick}
      >
        {/* 시간 눈금 */}
        <div style={{ position: 'absolute', top: 0, left: HEADER_W, right: 0, height: 18, borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
          {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => i).filter(i => i % Math.max(1, Math.round(duration / 10)) === 0).map(sec => (
            <div key={sec} style={{
              position: 'absolute',
              left: `${(sec / duration) * 100}%`,
              fontSize: '0.4rem', color: '#475569',
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
            }}>{sec}s</div>
          ))}
        </div>

        {/* 현재 재생 위치 */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, zIndex: 20, pointerEvents: 'none',
          left: `calc(${HEADER_W}px + ${duration > 0 ? (currentTime / duration) * 100 : 0}% * (100% - ${HEADER_W}px) / 100%)`,
          width: 1, background: '#ef4444',
        }} />

        {/* 트랙 rows */}
        {tracks.map((track, ti) => {
          const rowTop = 20 + ti * ROW_H;
          const isActive = track.id === activeTrackId;
          return (
            <div key={track.id}
              style={{ position: 'absolute', top: rowTop, left: 0, right: 0, height: ROW_H }}
              onClick={(e) => { e.stopPropagation(); onSelectTrack(track.id); }}
            >
              {/* 헤더 (왼쪽 고정) */}
              <div style={{
                position: 'absolute', left: 0, top: 0, width: HEADER_W, height: '100%',
                display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px',
                background: isActive ? 'rgba(168,85,247,0.12)' : '#0a0f1e',
                borderRight: `1px solid ${isActive ? track.color : 'rgba(255,255,255,0.06)'}`,
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                zIndex: 10,
              }}>
                <img src={track.image} alt="" style={{ width: 16, height: 16, objectFit: 'contain', flexShrink: 0 }} />
                <span style={{ fontSize: '0.45rem', color: track.color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.name}</span>
                <button onClick={(e) => { e.stopPropagation(); onUpdateTrack(track.id, { visible: !track.visible }); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: track.visible ? '#94a3b8' : '#334155', padding: 0, fontSize: '0.6rem', lineHeight: 1 }} title="가시성">
                  {track.visible ? '👁' : '🚫'}
                </button>
                <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`"${track.name}" 트랙 삭제?`)) onDeleteTrack(track.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0, fontSize: '0.55rem', lineHeight: 1 }} title="삭제">✕</button>
              </div>

              {/* 트랙 영역 */}
              <div style={{ position: 'absolute', left: HEADER_W, top: 0, right: 0, height: '100%', borderBottom: '1px solid rgba(255,255,255,0.05)', background: isActive ? 'rgba(168,85,247,0.04)' : 'transparent' }}>

                {/* 비활성 영역 (startTime 전) */}
                {track.startTime > 0 && (
                  <div style={{
                    position: 'absolute', top: '20%', height: '60%',
                    left: 0,
                    width: `${(track.startTime / duration) * 100}%`,
                    background: 'rgba(0,0,0,0.4)',
                  }} />
                )}
                {/* 비활성 영역 (endTime 후) */}
                {track.endTime < duration && (
                  <div style={{
                    position: 'absolute', top: '20%', height: '60%',
                    left: `${(track.endTime / duration) * 100}%`,
                    right: 0,
                    background: 'rgba(0,0,0,0.4)',
                  }} />
                )}

                {/* 활성 구간 바 */}
                <div style={{
                  position: 'absolute', top: '30%', height: '40%',
                  left: `${(track.startTime / duration) * 100}%`,
                  width: `${((track.endTime - track.startTime) / duration) * 100}%`,
                  background: `${track.color}22`,
                  border: `1px solid ${track.color}44`,
                  borderRadius: 2,
                }}>
                  {/* 구간별 눈 토글 (키프레임 사이 영역) */}
                  {track.keyframes.length > 0 && (() => {
                    const segs: { left: number; width: number; idx: number }[] = [];
                    const rangeDur = track.endTime - track.startTime;
                    // 첫 KF 전
                    if (track.keyframes[0].time > track.startTime) {
                      segs.push({ left: 0, width: ((track.keyframes[0].time - track.startTime) / rangeDur) * 100, idx: 0 });
                    }
                    // KF 사이
                    for (let i = 0; i < track.keyframes.length - 1; i++) {
                      const l = ((track.keyframes[i].time - track.startTime) / rangeDur) * 100;
                      const w = ((track.keyframes[i + 1].time - track.keyframes[i].time) / rangeDur) * 100;
                      segs.push({ left: l, width: w, idx: i + 1 });
                    }
                    // 마지막 KF 후
                    const lastKF = track.keyframes[track.keyframes.length - 1];
                    if (lastKF.time < track.endTime) {
                      const l = ((lastKF.time - track.startTime) / rangeDur) * 100;
                      segs.push({ left: l, width: 100 - l, idx: track.keyframes.length });
                    }
                    return segs.map(seg => (
                      <div key={seg.idx}
                        onClick={(e) => { e.stopPropagation(); onToggleSegment(track.id, seg.idx); }}
                        style={{
                          position: 'absolute', top: 0, bottom: 0,
                          left: `${seg.left}%`, width: `${seg.width}%`,
                          background: (track.segmentVisible[seg.idx] ?? true) ? 'transparent' : 'rgba(0,0,0,0.6)',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.4rem',
                          color: (track.segmentVisible[seg.idx] ?? true) ? 'transparent' : '#64748b',
                          border: (track.segmentVisible[seg.idx] ?? true) ? 'none' : '1px dashed #334155',
                        }}
                        title={`구간 ${seg.idx}: ${(track.segmentVisible[seg.idx] ?? true) ? '표시 중' : '숨김'}`}
                      >
                        {!(track.segmentVisible[seg.idx] ?? true) && '🚫'}
                      </div>
                    ));
                  })()}
                </div>

                {/* startTime 드래그 핸들 */}
                <div
                  onMouseDown={(e) => handleDragRange(track.id, 'start', e)}
                  style={{
                    position: 'absolute', top: '15%', height: '70%', width: 6,
                    left: `calc(${(track.startTime / duration) * 100}% - 3px)`,
                    background: track.color, borderRadius: 2, cursor: 'ew-resize', zIndex: 5,
                  }} title="시작 시간 드래그" />
                {/* endTime 드래그 핸들 */}
                <div
                  onMouseDown={(e) => handleDragRange(track.id, 'end', e)}
                  style={{
                    position: 'absolute', top: '15%', height: '70%', width: 6,
                    left: `calc(${(track.endTime / duration) * 100}% - 3px)`,
                    background: track.color, borderRadius: 2, cursor: 'ew-resize', zIndex: 5,
                  }} title="종료 시간 드래그" />

                {/* 키프레임 마커 */}
                {track.keyframes.map((kf, ki) => (
                  <div key={ki}
                    onMouseDown={(e) => handleDragKF(track.id, ki, e)}
                    onDoubleClick={(e) => { e.stopPropagation(); if (window.confirm(`키프레임 ${ki + 1} 삭제?`)) onDeleteKeyframe(track.id, ki); }}
                    style={{
                      position: 'absolute',
                      left: `${((kf.time - track.startTime) / Math.max(1, track.endTime - track.startTime)) * 100}%`,
                      top: '50%',
                      transform: 'translate(-50%, -50%) rotate(45deg)',
                      width: 10, height: 10,
                      background: isActive ? track.color : '#64748b',
                      border: `2px solid ${track.color}`,
                      borderRadius: 2,
                      cursor: 'grab', zIndex: 10,
                      boxShadow: `0 0 4px ${track.color}88`,
                    }}
                    title={`KF${ki + 1}: ${kf.time.toFixed(1)}s\n더블클릭으로 삭제 / 드래그로 이동`}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* 헤더 세로선 */}
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: HEADER_W, width: 1, background: 'rgba(255,255,255,0.08)', zIndex: 5 }} />
      </div>
    </div>
  );
};

export default StickerTimeline;
