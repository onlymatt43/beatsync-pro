
"use client";
import { useRef, useState } from "react";

export default function App() {
  const [onsetNotes, setOnsetNotes] = useState<number[]>([]);
  const [beatNotes, setBeatNotes] = useState<number[]>([]);
  const [onsetCount, setOnsetCount] = useState(0);
  const [beatCount, setBeatCount] = useState(0);
  const [analyzeMode, setAnalyzeMode] = useState<"onset" | "beat">("onset");
  const [audioDurationSec, setAudioDurationSec] = useState(0);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [videoCount, setVideoCount] = useState(0);
  const [videoNames, setVideoNames] = useState<string[]>([]);
  const [video, setVideo] = useState("");
  const [alternateVideo, setAlternateVideo] = useState("");
  const [segments, setSegments] = useState<Array<{ audioStart: number; audioEnd: number; sourceIndex: number; sourceStart: number; sourceEnd: number }>>([]);
  const [jobId, setJobId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [minSeg, setMinSeg] = useState("0");

  // Nouveaux états pour les previews
  const [previews, setPreviews] = useState<Array<{
    video: string;
    segments: Array<{ audioStart: number; audioEnd: number; sourceIndex: number; sourceStart: number; sourceEnd: number }>;
    duration: number;
    startTime: number;
  }>>([]);
  const [selectedPreview, setSelectedPreview] = useState<number | null>(null);

  const audioRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  const parseApiResponse = async (res: Response): Promise<{ data: any; text: string }> => {
    const text = await res.text();
    if (!text) {
      return { data: null, text: "" };
    }
    try {
      return { data: JSON.parse(text), text };
    } catch {
      return { data: null, text };
    }
  };

  const activeNotes = analyzeMode === "beat" ? beatNotes : onsetNotes;
  const activeCount = analyzeMode === "beat" ? beatCount : onsetCount;

  const pollRenderStatus = async (jobIdValue: string) => {
    const maxAttempts = 180;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const statusRes = await fetch(`/api/render/status?jobId=${encodeURIComponent(jobIdValue)}`);
      const { data, text } = await parseApiResponse(statusRes);

      if (statusRes.status === 202) {
        continue;
      }

      if (!statusRes.ok) {
        throw new Error(data?.error || text || `Build échoué (${statusRes.status}).`);
      }

      if (!data?.video) {
        throw new Error("Réponse build invalide.");
      }

      return data;
    }

    throw new Error("Build en attente trop longtemps. Réessaie dans quelques instants.");
  };

  const resetAnalysis = () => {
    setOnsetNotes([]);
    setBeatNotes([]);
    setOnsetCount(0);
    setBeatCount(0);
    setAudioDurationSec(0);
    setWaveform([]);
    setVideoCount(0);
    setVideoNames([]);
    setVideo("");
    setAlternateVideo("");
    setSegments([]);
    setJobId("");
  };

  const getSelectedVideos = (): File[] => {
    const files = videoRef.current?.files;
    return files ? Array.from(files) : [];
  };

  const analyze = async () => {
    setError("");

    const audio = audioRef.current?.files?.[0];
    if (!audio) {
      setError("Sélectionne un fichier audio.");
      return;
    }

    const form = new FormData();
    form.append("audio", audio);
    form.append("mode", analyzeMode);

    setBusy(true);
    try {
      const res = await fetch("/api/analyze", { method: "POST", body: form });
      const { data, text } = await parseApiResponse(res);
      if (!res.ok) {
        setError(data?.error || text || `Analyze échoué (${res.status}).`);
        return;
      }

      if (!data) {
        setError("Réponse analyse invalide.");
        return;
      }

      setOnsetNotes(Array.isArray(data.onsetNotes) ? data.onsetNotes : []);
      setBeatNotes(Array.isArray(data.beatNotes) ? data.beatNotes : []);
      setOnsetCount(typeof data.onsetCount === "number" ? data.onsetCount : 0);
      setBeatCount(typeof data.beatCount === "number" ? data.beatCount : 0);
      setAudioDurationSec(typeof data.durationSec === "number" ? data.durationSec : 0);
      setWaveform(Array.isArray(data.waveform) ? data.waveform : []);
      const selectedVideos = getSelectedVideos();
      setVideoCount(selectedVideos.length);
      setVideoNames(selectedVideos.map((videoFile) => videoFile.name));
      setJobId(typeof data.jobId === "string" ? data.jobId : "");
      setVideo("");
      setAlternateVideo("");
      setSegments([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze échoué.");
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    setError("");
    if (!jobId) {
      setError("Lance l'analyse avant de construire.");
      return;
    }
    const selectedVideos = getSelectedVideos();
    if (selectedVideos.length === 0) {
      setError("Ajoute au moins une vidéo avant de construire.");
      return;
    }
    if (activeNotes.length < 2) {
      setError("Pas assez de notes pour construire la vidéo.");
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append("jobId", jobId);
      form.append("notes", JSON.stringify(activeNotes));
      form.append("minSeg", String(Number(minSeg) || 0));
      form.append("async", "true");
      selectedVideos.forEach((videoFile) => form.append("video", videoFile));

      const res = await fetch("/api/render", {
        method: "POST",
        body: form
      });

      const { data, text } = await parseApiResponse(res);

      if (res.status === 202) {
        const completed = await pollRenderStatus(jobId);
        setVideo(completed.video || "");
        setAlternateVideo(completed.alternateVideo || "");
        setSegments(Array.isArray(completed.segments) ? completed.segments : []);
        return;
      }

      if (!res.ok) {
        setError(data?.error || text || `Build échoué (${res.status}).`);
        return;
      }

      if (!data) {
        setError("Réponse build invalide.");
        return;
      }

      setVideo(data.video || "");
      setAlternateVideo(data.alternateVideo || "");
      setSegments(Array.isArray(data.segments) ? data.segments : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Build échoué.");
    } finally {
      setBusy(false);
    }
  };

  const generatePreviews = async () => {
    setError("");
    if (!jobId) {
      setError("Lance l'analyse avant de générer les previews.");
      return;
    }
    const selectedVideos = getSelectedVideos();
    if (selectedVideos.length === 0) {
      setError("Ajoute au moins une vidéo avant de générer les previews.");
      return;
    }
    if (activeNotes.length < 2) {
      setError("Pas assez de notes pour générer les previews.");
      return;
    }

    setBusy(true);
    setPreviews([]);
    setSelectedPreview(null);
    try {
      const form = new FormData();
      form.append("jobId", jobId);
      form.append("notes", JSON.stringify(activeNotes));
      form.append("minSeg", String(Number(minSeg) || 0));
      form.append("preview", "true");
      selectedVideos.forEach((videoFile) => form.append("video", videoFile));

      const res = await fetch("/api/render", {
        method: "POST",
        body: form
      });

      const { data, text } = await parseApiResponse(res);
      if (!res.ok) {
        setError(data?.error || text || `Génération des previews échouée (${res.status}).`);
        return;
      }

      if (!data) {
        setError("Réponse preview invalide.");
        return;
      }

      setPreviews(Array.isArray(data.previews) ? data.previews : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Génération des previews échouée.");
    } finally {
      setBusy(false);
    }
  };

  const selectPreview = (index: number) => {
    setSelectedPreview(index);
    // On pourrait pré-remplir les paramètres avec ceux du preview sélectionné
  };

  const timelineWidth = 100;
  const waveformPoints = waveform.length > 0
    ? waveform.map((value, index) => {
        const x = waveform.length === 1 ? 0 : (index / (waveform.length - 1)) * timelineWidth;
        const y = 20 - (value * 18);
        return `${x},${y}`;
      }).join(" ")
    : "";

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent mb-2">
            BeatSync PRO
          </h1>
          <p className="text-gray-300 text-lg">Synchronise tes vidéos avec les beats de ta musique</p>
        </div>

        {/* Main Card */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
          {/* File Inputs */}
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                📹 Vidéos sources
              </label>
              <div className="relative">
                <input
                  ref={videoRef}
                  type="file"
                  accept="video/*"
                  multiple
                  className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-cyan-500 file:text-white hover:file:bg-cyan-600 transition-colors"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                🎵 Audio (mp3, wav, m4a…)
              </label>
              <div className="relative">
                <input
                  ref={audioRef}
                  type="file"
                  accept="audio/*"
                  className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-purple-500 file:text-white hover:file:bg-purple-600 transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Settings */}
          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                ⏱️ Durée minimale d'un segment (secondes)
              </label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={minSeg}
                onChange={(e) => setMinSeg(e.target.value)}
                className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                🎯 Mode d'analyse
              </label>
              <select
                value={analyzeMode}
                onChange={(e) => {
                  setAnalyzeMode(e.target.value as "onset" | "beat");
                }}
                className="w-full px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent"
              >
                <option value="onset" className="bg-gray-800">🎵 Onsets / attaques</option>
                <option value="beat" className="bg-gray-800">🥁 Beats</option>
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 mb-6">
            <button
              onClick={analyze}
              disabled={busy}
              className="flex-1 px-8 py-4 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold rounded-xl transition-all duration-200 transform hover:scale-105 disabled:transform-none disabled:cursor-not-allowed shadow-lg"
            >
              {busy ? "🔄 ANALYSE EN COURS..." : "🚀 ANALYSER"}
            </button>
            <button
              onClick={generatePreviews}
              disabled={busy || !jobId || activeNotes.length < 2}
              className="flex-1 px-8 py-4 bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold rounded-xl transition-all duration-200 transform hover:scale-105 disabled:transform-none disabled:cursor-not-allowed shadow-lg"
            >
              {busy ? "🔄 PRÉVIEWS..." : "👀 GÉNÉRER PREVIEWS"}
            </button>
            <button
              onClick={build}
              disabled={busy || !jobId || activeNotes.length < 2}
              className="flex-1 px-8 py-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 disabled:from-gray-600 disabled:to-gray-700 text-white font-bold rounded-xl transition-all duration-200 transform hover:scale-105 disabled:transform-none disabled:cursor-not-allowed shadow-lg"
            >
              {busy ? "🔄 CONSTRUCTION..." : "🎬 CONSTRUIRE"}
            </button>
          </div>

          {/* Status */}
          {busy && (
            <div className="text-center py-4">
              <div className="inline-flex items-center px-4 py-2 bg-blue-500/20 border border-blue-400/30 rounded-lg">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-400 border-t-transparent mr-3"></div>
                <span className="text-blue-300 font-medium">Traitement en cours…</span>
              </div>
            </div>
          )}

          {/* Analysis Results */}
          {(onsetNotes.length > 0 || beatNotes.length > 0) && !video && (
            <div className="bg-white/5 rounded-xl p-6 mb-6 border border-white/10">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold text-cyan-300">📊 Analyse terminée</h3>
                <div className="text-sm text-gray-400">
                  {onsetCount} onsets · {beatCount} beats
                  {activeCount > 0 ? ` · rendu: ${analyzeMode === "beat" ? "beats" : "onsets"}` : ""}
                  {videoCount > 1 ? ` · ${videoCount} vidéos` : ""}
                </div>
              </div>

              {videoNames.length > 0 && (
                <div className="mb-4">
                  <div className="text-sm text-gray-400 mb-2">📋 Ordre détecté :</div>
                  <div className="space-y-1">
                    {videoNames.map((name, index) => (
                      <div key={`${index}-${name}`} className="text-sm text-gray-300 flex items-center">
                        <span className="w-6 h-6 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-xs font-bold mr-3">
                          {index + 1}
                        </span>
                        {name}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Previews Section */}
          {previews.length > 0 && (
            <div className="bg-white/5 rounded-xl p-6 mb-6 border border-white/10">
              <h3 className="text-xl font-semibold text-orange-300 mb-6">👀 Previews générés</h3>
              <p className="text-gray-300 mb-4">
                Voici 3 extraits de 12 secondes chacun. Clique sur celui que tu préfères pour le sélectionner :
              </p>

              <div className="grid gap-4">
                {previews.map((preview, index) => (
                  <div
                    key={index}
                    className={`bg-black/30 rounded-lg p-4 border-2 transition-all duration-200 cursor-pointer ${
                      selectedPreview === index
                        ? 'border-orange-400 bg-orange-500/10'
                        : 'border-white/20 hover:border-orange-300'
                    }`}
                    onClick={() => selectPreview(index)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center">
                        <span className="text-lg mr-3">
                          {selectedPreview === index ? '✅' : '👆'}
                        </span>
                        <span className="text-white font-medium">
                          Preview {index + 1} - {preview.startTime.toFixed(1)}s à {(preview.startTime + preview.duration).toFixed(1)}s
                        </span>
                      </div>
                      <div className="text-sm text-gray-400">
                        {preview.segments.length} segments
                      </div>
                    </div>

                    <video
                      src={preview.video}
                      controls
                      className="w-full rounded-lg"
                      style={{ maxHeight: '200px' }}
                    />
                  </div>
                ))}
              </div>

              {selectedPreview !== null && (
                <div className="mt-6 p-4 bg-green-500/20 border border-green-400/30 rounded-lg">
                  <div className="flex items-center">
                    <span className="text-green-400 mr-3">🎯</span>
                    <span className="text-green-300">
                      Preview {selectedPreview + 1} sélectionné ! Tu peux maintenant cliquer sur "CONSTRUIRE" pour générer la vidéo complète avec ces paramètres.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="bg-red-500/20 border border-red-400/30 rounded-xl p-4 mb-6">
              <div className="flex items-center">
                <span className="text-red-400 mr-3">⚠️</span>
                <span className="text-red-300">{error}</span>
              </div>
            </div>
          )}

          {/* Timeline Visualization */}
          {audioDurationSec > 0 && (onsetNotes.length > 0 || beatNotes.length > 0) && (
            <div className="bg-white/5 rounded-xl p-6 mb-6 border border-white/10">
              <h3 className="text-xl font-semibold text-purple-300 mb-6">📈 Diagnostic timeline</h3>

              <div className="space-y-6">
                <div>
                  <div className="text-sm text-gray-400 mb-3">🎵 Ligne audio + onsets</div>
                  <div className="bg-black/50 rounded-lg p-4">
                    <svg viewBox="0 0 100 24" className="w-full h-12">
                      <polyline fill="none" stroke="#06b6d4" strokeWidth="0.8" points={waveformPoints} />
                      {onsetNotes.map((note, index) => {
                        const x = audioDurationSec > 0 ? (note / audioDurationSec) * timelineWidth : 0;
                        return <line key={`note-${index}`} x1={x} x2={x} y1={0} y2={24} stroke="#fbbf24" strokeWidth="0.5" />;
                      })}
                    </svg>
                  </div>
                </div>

                <div>
                  <div className="text-sm text-gray-400 mb-3">🥁 Ligne audio + beats</div>
                  <div className="bg-black/50 rounded-lg p-4">
                    <svg viewBox="0 0 100 24" className="w-full h-12">
                      <polyline fill="none" stroke="#06b6d4" strokeWidth="0.8" points={waveformPoints} />
                      {beatNotes.map((note, index) => {
                        const x = audioDurationSec > 0 ? (note / audioDurationSec) * timelineWidth : 0;
                        return <line key={`beat-${index}`} x1={x} x2={x} y1={0} y2={24} stroke="#10b981" strokeWidth="0.5" />;
                      })}
                    </svg>
                  </div>
                </div>

                <div>
                  <div className="text-sm text-gray-400 mb-3">
                    🎬 Ligne vidéo utilisée ({analyzeMode === "beat" ? "rendu beats" : "rendu onsets"})
                  </div>
                  <div className="bg-black/50 rounded-lg p-4">
                    <svg viewBox="0 0 100 16" className="w-full h-9">
                      {segments.map((segment, index) => {
                        const x = audioDurationSec > 0 ? (segment.audioStart / audioDurationSec) * timelineWidth : 0;
                        const width = audioDurationSec > 0 ? ((segment.audioEnd - segment.audioStart) / audioDurationSec) * timelineWidth : 0;
                        const colors = ["#ef4444", "#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#f97316"];
                        return (
                          <rect
                            key={`segment-${index}`}
                            x={x}
                            y={2}
                            width={Math.max(width, 0.4)}
                            height={12}
                            fill={colors[segment.sourceIndex % colors.length]}
                            opacity={0.9}
                            rx={1}
                          />
                        );
                      })}
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Video Results */}
          {video && (
            <div className="space-y-6">
              <div className="bg-white/5 rounded-xl p-6 border border-white/10">
                <h3 className="text-xl font-semibold text-green-300 mb-4">🎥 Vidéo générée</h3>
                <video
                  src={video}
                  controls
                  className="w-full rounded-lg shadow-lg mb-4"
                  style={{ maxHeight: '400px' }}
                />
                <div className="flex flex-col sm:flex-row gap-3">
                  <a
                    href={video}
                    download={`beatsync-${jobId || "output"}.mp4`}
                    className="flex-1 px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold rounded-lg text-center transition-all duration-200 transform hover:scale-105 shadow-lg"
                  >
                    💾 TÉLÉCHARGER MP4
                  </a>
                  <a
                    href={video}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white font-bold rounded-lg text-center transition-all duration-200 border border-white/20"
                  >
                    🔗 OUVRIR DANS UN ONGLET
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Alternate Video */}
          {alternateVideo && (
            <div className="bg-white/5 rounded-xl p-6 border border-white/10">
              <h3 className="text-xl font-semibold text-orange-300 mb-4">🔄 Deuxième tour</h3>
              <video
                src={alternateVideo}
                controls
                className="w-full rounded-lg shadow-lg mb-4"
                style={{ maxHeight: '400px' }}
              />
              <div className="flex flex-col sm:flex-row gap-3">
                <a
                  href={alternateVideo}
                  download={`beatsync-${jobId || "output"}-tour-2.mp4`}
                  className="flex-1 px-6 py-3 bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-bold rounded-lg text-center transition-all duration-200 transform hover:scale-105 shadow-lg"
                >
                  💾 TÉLÉCHARGER MP4 2
                </a>
                <a
                  href={alternateVideo}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white font-bold rounded-lg text-center transition-all duration-200 border border-white/20"
                >
                  🔗 OUVRIR TOUR 2
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

