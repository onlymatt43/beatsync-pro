#!/usr/bin/env python3
"""
render.py <job_dir> [--scene-detect] [--quality-filter] [--mini-clips]

Reads:
    job_dir/notes.json  {"notes": [...], "minSeg": 0.0}
  job_dir/audio.mp3
    job_dir/input1.mp4, input2.mp4, ...

Writes:
  job_dir/output.mp4
  job_dir/drop_01.mp4, buildup_01.mp4, ... (if --mini-clips)

Stdout: JSON {"status": "ok", "miniClips": [...]}
Stderr: progress info
"""

import sys

# Redirect stdout to stderr for the entire script so that library output
# (moviepy progress, ffmpeg logs, etc.) does not corrupt the JSON result.
# We restore real_stdout only for the final JSON print.
_real_stdout = sys.stdout
sys.stdout = sys.stderr
import os
import json
import random
import tempfile
import shutil
import argparse
import subprocess

import librosa
from moviepy import VideoFileClip, AudioFileClip, concatenate_videoclips
import cv2
import numpy as np


def _detect_scene_times(video_path, threshold=0.3):
    """Détecte les timestamps de changement de scène via ffmpeg."""
    cmd = [
        "ffmpeg", "-hide_banner", "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-vsync", "vfn", "-f", "null", "-"
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        import re
        times = []
        for line in result.stderr.split('\n'):
            match = re.search(r'pts_time:(\d+\.?\d*)', line)
            if match:
                times.append(float(match.group(1)))
        return times
    except Exception as e:
        print(f"⚠️  Détection de scène échouée : {e}")
        return []


def _split_by_scenes(clip, clip_name, min_scene_dur=1.0):
    """Pré-découpe un clip aux changements de scène."""
    scene_times = _detect_scene_times(clip_name)
    if not scene_times:
        return [clip]

    # Construire les points de coupe : [0, scene1, scene2, ..., durée]
    cuts = [0.0]
    for t in scene_times:
        if t - cuts[-1] >= min_scene_dur and t < clip.duration:
            cuts.append(t)
    if clip.duration - cuts[-1] >= min_scene_dur:
        cuts.append(clip.duration)
    elif cuts[-1] != clip.duration:
        cuts[-1] = clip.duration  # étendre le dernier segment

    if len(cuts) < 2:
        return [clip]

    segments = []
    for j in range(len(cuts) - 1):
        sub = clip.subclipped(cuts[j], cuts[j + 1])
        segments.append(sub)

    return segments


def _score_segment(clip, sample_interval=0.5):
    """Score un segment par mouvement (optical flow) et netteté (Laplacien)."""
    dur = clip.duration
    if dur < 0.1:
        return 0.0

    # Échantillonner des frames à intervalle régulier
    times = np.arange(0, dur, sample_interval)
    if len(times) < 2:
        times = np.array([0, dur * 0.5]) if dur > 0.2 else np.array([0])

    frames = []
    for t in times:
        t = min(t, dur - 0.01)
        try:
            frame = clip.get_frame(t)
            gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
            # Réduire la résolution pour accélérer l'analyse
            gray = cv2.resize(gray, (320, 240))
            frames.append(gray)
        except Exception:
            continue

    if len(frames) < 2:
        return 0.5  # score neutre si pas assez de frames

    # --- Netteté (Laplacien) ---
    sharpness_scores = []
    for f in frames:
        lap = cv2.Laplacian(f, cv2.CV_64F).var()
        sharpness_scores.append(lap)
    avg_sharpness = np.mean(sharpness_scores)

    # --- Mouvement (différence de frames) ---
    motion_scores = []
    for i in range(1, len(frames)):
        diff = cv2.absdiff(frames[i], frames[i - 1])
        motion_scores.append(np.mean(diff))
    avg_motion = np.mean(motion_scores) if motion_scores else 0.0

    return avg_sharpness, avg_motion


def _filter_segments_by_quality(segments):
    """Filtre les segments véritablement statiques."""
    if len(segments) <= 1:
        return segments

    print(f"   🔍 Analyse qualité de {len(segments)} segments...", file=sys.stderr)
    MOTION_FLOOR = 2.0  # Diff moyenne < 2 = véritablement statique

    kept = []
    removed_reasons = []
    for i, seg in enumerate(segments):
        result = _score_segment(seg)
        if isinstance(result, tuple):
            _, motion = result
        else:
            motion = 0.0

        if motion < MOTION_FLOOR:
            removed_reasons.append(f"      segment {i+1} ({seg.duration:.1f}s) — statique (motion={motion:.1f})")
        else:
            kept.append(seg)

    if removed_reasons:
        print(f"   🗑️  Retirés :", file=sys.stderr)
        for r in removed_reasons:
            print(r, file=sys.stderr)

    if not kept:
        print("   ⚠️  Tous les segments seraient retirés — on garde tout", file=sys.stderr)
        return segments

    print(f"   ✅ {len(kept)}/{len(segments)} segments retenus", file=sys.stderr)
    return kept
    tmp_dir = tempfile.mkdtemp(prefix="beatsync_transcode_")
    dst = os.path.join(tmp_dir, "transcoded.mp4")
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", src_path,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        dst
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            print(f"Transcode failed: {result.stderr.decode(errors='replace')}", file=sys.stderr)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return None, None
        return dst, tmp_dir
    except Exception as e:
        print(f"Transcode error: {e}", file=sys.stderr)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return None, None


def _load_video(path):
    try:
        return VideoFileClip(path), None
    except Exception as e:
        print(f"Load warning {path}: {e}", file=sys.stderr)
        transcoded, tmp_dir = _transcode_to_compatible(path)
        if not transcoded:
            return None, None
        try:
            return VideoFileClip(transcoded), tmp_dir
        except Exception as e2:
            print(f"Load failed after transcode: {e2}", file=sys.stderr)
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            return None, None


def _build_output_clips(raw_videos, beat_times, audio_duration, min_seg, variation_index):
    output_clips = []
    segments = []
    start_time = 0.0

    if len(raw_videos) == 1:
        video = raw_videos[0]
        ratio = video.duration / audio_duration if audio_duration > 0 else 1.0
        current_video_time = 0.0 if variation_index == 0 else video.duration * 0.5
        rng = random.Random(variation_index + 1)

        for i, end_time in enumerate(beat_times):
            duration = end_time - start_time
            if duration < min_seg and i < len(beat_times) - 1:
                continue

            step = duration * ratio
            max_start = max(video.duration - duration, 0.0)
            vid_start = min(current_video_time, max_start)
            vid_end = vid_start + duration

            if vid_end >= video.duration:
                current_video_time = 0.0
                vid_start = 0.0
                vid_end = duration

            sub = video.subclipped(vid_start, vid_end)
            output_clips.append(sub)
            segments.append({
                "audioStart": round(float(start_time), 6),
                "audioEnd": round(float(end_time), 6),
                "sourceIndex": 0,
                "sourceStart": round(float(vid_start), 6),
                "sourceEnd": round(float(vid_end), 6),
            })

            jump = step if variation_index > 0 else step * rng.uniform(0.8, 1.2)
            current_video_time += jump
            start_time = end_time

        return output_clips, segments

    total_notes = len(beat_times)
    total_clip_duration = sum(video.duration for video in raw_videos)
    clip_note_limits = []

    for video in raw_videos:
        share = video.duration / total_clip_duration if total_clip_duration > 0 else 0.0
        clip_note_limits.append(max(1, round(total_notes * share)))

    diff = total_notes - sum(clip_note_limits)
    clip_note_limits[-1] = max(1, clip_note_limits[-1] + diff)

    num_clips = len(raw_videos)
    clip_index = 0 if variation_index == 0 else variation_index % num_clips
    clip_positions = [0.0 for _ in raw_videos]
    if variation_index > 0:
        clip_positions = [max(0.0, video.duration * 0.5) for video in raw_videos]
    note_count_in_clip = 0

    for i, end_time in enumerate(beat_times):
        duration = end_time - start_time
        if duration < min_seg and i < len(beat_times) - 1:
            continue

        current_clip = raw_videos[clip_index]

        if note_count_in_clip >= clip_note_limits[clip_index] and clip_index < num_clips - 1:
            clip_index += 1
            current_clip = raw_videos[clip_index]
            note_count_in_clip = 0

        max_start = max(current_clip.duration - duration, 0.0)
        clip_time = min(clip_positions[clip_index], max_start)
        if clip_time + duration > current_clip.duration:
            clip_index = (clip_index + 1) % num_clips
            current_clip = raw_videos[clip_index]
            note_count_in_clip = 0
            attempts = 0

            while duration > current_clip.duration and attempts < num_clips:
                clip_index = (clip_index + 1) % num_clips
                current_clip = raw_videos[clip_index]
                attempts += 1

            if duration > current_clip.duration:
                start_time = end_time
                continue

            max_start = max(current_clip.duration - duration, 0.0)
            clip_time = min(clip_positions[clip_index], max_start)
            if clip_time + duration > current_clip.duration:
                clip_time = 0.0

        sub = current_clip.subclipped(clip_time, clip_time + duration)
        output_clips.append(sub)
        segments.append({
            "audioStart": round(float(start_time), 6),
            "audioEnd": round(float(end_time), 6),
            "sourceIndex": clip_index,
            "sourceStart": round(float(clip_time), 6),
            "sourceEnd": round(float(clip_time + duration), 6),
        })
        clip_positions[clip_index] = clip_time + duration
        note_count_in_clip += 1
        start_time = end_time

    return output_clips, segments


def _render_variant(output_clips, audio_source, audio_duration, output_path, fps):
    if not output_clips:
        print("No clips assembled", file=sys.stderr)
        sys.exit(1)

    print(f"Assembling {len(output_clips)} segments...", file=sys.stderr)

    # audio_source peut être un chemin (string) ou un AudioFileClip
    if isinstance(audio_source, str):
        audio = AudioFileClip(audio_source)
    else:
        audio = audio_source

    final_clip = concatenate_videoclips(output_clips, method="compose")
    final_clip = final_clip.with_audio(audio)

    if final_clip.duration > audio_duration:
        final_clip = final_clip.subclipped(0, audio_duration)

    print(f"Exporting to {output_path} ({fps} fps)...", file=sys.stderr)
    final_clip.write_videofile(output_path, codec="libx264", audio_codec="aac", fps=fps, logger=None)
    final_clip.close()

    # Ne fermer l'audio que si c'est nous qui l'avons créé (à partir d'un chemin)
    if isinstance(audio_source, str):
        audio.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir")
    parser.add_argument("--min-seg", type=float, default=0.0)
    parser.add_argument("--preview", action="store_true", help="Generate short preview clips instead of full video")
    args = parser.parse_args()

    job_dir = args.job_dir
    min_seg = max(args.min_seg, 0.0)
    is_preview = args.preview

    notes_path = os.path.join(job_dir, "notes.json")
    with open(notes_path) as f:
        data = json.load(f)
    notes = data.get("notes", [])

    if not notes:
        print("No notes in notes.json", file=sys.stderr)
        sys.exit(1)

    audio_path = os.path.join(job_dir, "audio.mp3")
    print(f"Loading audio: {audio_path}", file=sys.stderr)
    audio = AudioFileClip(audio_path)

    video_paths = []
    index = 1
    while True:
        video_path = os.path.join(job_dir, f"input{index}.mp4")
        if not os.path.exists(video_path):
            break
        video_paths.append(video_path)
        index += 1

    if not video_paths:
        print("No input videos found", file=sys.stderr)
        sys.exit(1)

    raw_videos = []
    tmp_dirs = []
    for video_path in video_paths:
        print(f"Loading video: {video_path}", file=sys.stderr)
        video, tmp_dir = _load_video(video_path)
        if video is None:
            continue
        raw_videos.append(video)
        if tmp_dir:
            tmp_dirs.append(tmp_dir)

    if not raw_videos:
        print("No loadable input videos", file=sys.stderr)
        sys.exit(1)


    beat_times = list(notes)
    if beat_times[-1] < audio.duration:
        beat_times.append(audio.duration)

    fps = 24

    if is_preview:
        # Mode preview : générer 3 courts extraits de 12 secondes chacun
        preview_duration = 12.0  # secondes
        previews = []

        # Toujours générer 3 previews, même si l'audio est court
        audio_length = audio.duration
        if audio_length >= preview_duration * 3:
            # Points de départ : début, milieu, fin (en évitant les chevauchements)
            start_times = [
                0.0,  # début
                audio_length / 2 - preview_duration / 2,  # milieu
                audio_length - preview_duration  # fin
            ]
        elif audio_length >= preview_duration * 2:
            # 2 previews si assez long
            start_times = [
                0.0,  # début
                audio_length - preview_duration  # fin
            ]
        else:
            # Au minimum 1 preview
            start_times = [0.0]

        # S'assurer qu'on a exactement 3 start_times en dupliquant si nécessaire
        while len(start_times) < 3:
            start_times.append(start_times[-1])

        for i, start_time in enumerate(start_times[:3]):  # Prendre max 3
            end_time = min(start_time + preview_duration, audio_length)

            # Filtrer les beat_times pour cette période
            preview_beat_times = [t for t in beat_times if start_time <= t <= end_time]
            if not preview_beat_times:
                # Si pas de beats dans cette période, créer des beats artificiels
                preview_beat_times = [start_time + j * 0.5 for j in range(int(preview_duration / 0.5))]
                if preview_beat_times[-1] < end_time:
                    preview_beat_times.append(end_time)

            # Ajuster les temps relatifs à l'extrait
            relative_beat_times = [t - start_time for t in preview_beat_times]
            if relative_beat_times and relative_beat_times[-1] < preview_duration:
                relative_beat_times.append(preview_duration)

            # Générer l'extrait vidéo
            preview_output_clips, preview_segments = _build_output_clips(
                raw_videos, relative_beat_times, preview_duration, min_seg, i
            )

            if preview_output_clips:
                preview_path = os.path.join(job_dir, f"preview_{i+1}.mp4")

                # Extraire la partie audio correspondante au preview
                preview_audio = audio.subclipped(start_time, end_time)

                # Normaliser le volume de l'audio pour les previews (pour s'assurer qu'il soit audible)
                # Calculer le volume RMS moyen
                import numpy as np
                audio_array = preview_audio.to_soundarray()
                rms = np.sqrt(np.mean(audio_array**2))

                # Si le volume est trop faible, l'amplifier
                target_rms = 0.1  # Volume cible pour les previews
                if rms > 0 and rms < target_rms:
                    gain = target_rms / rms
                    preview_audio = preview_audio.multiply_volume(gain)
                    print(f"   🔊 Audio amplifié de {gain:.2f}x pour le preview {i+1}", file=sys.stderr)

                _render_variant(preview_output_clips, preview_audio, preview_duration, preview_path, fps)

                # Ajuster les segments pour inclure le temps absolu dans l'audio original
                adjusted_segments = []
                for seg in preview_segments:
                    adjusted_segments.append({
                        "audioStart": round(float(seg["audioStart"] + start_time), 6),
                        "audioEnd": round(float(seg["audioEnd"] + start_time), 6),
                        "sourceIndex": seg["sourceIndex"],
                        "sourceStart": seg["sourceStart"],
                        "sourceEnd": seg["sourceEnd"],
                    })

                previews.append({
                    "video": f"preview_{i+1}.mp4",
                    "segments": adjusted_segments,
                    "duration": preview_duration,
                    "startTime": start_time
                })

        audio.close()
        for video in raw_videos:
            video.close()
        for tmp_dir in tmp_dirs:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        print(json.dumps({
            "status": "ok",
            "previews": previews,
            "segments": []  # Pour compatibilité
        }), file=_real_stdout)

    else:
        # Mode normal : générer la vidéo complète
        output_path = os.path.join(job_dir, "output.mp4")
        alt_output_path = os.path.join(job_dir, "output_alt.mp4")
        output_clips, segments = _build_output_clips(raw_videos, beat_times, audio.duration, min_seg, 0)
        _render_variant(output_clips, audio, audio.duration, output_path, fps)

        alt_output_clips, alt_segments = _build_output_clips(raw_videos, beat_times, audio.duration, min_seg, 1)
        _render_variant(alt_output_clips, audio, audio.duration, alt_output_path, fps)

        audio.close()
        for video in raw_videos:
            video.close()
        for tmp_dir in tmp_dirs:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        print(json.dumps({
            "status": "ok",
            "video": "output.mp4",
            "alternateVideo": "output_alt.mp4",
            "segments": segments,
            "alternateSegments": alt_segments,
        }), file=_real_stdout)


if __name__ == "__main__":
    main()
