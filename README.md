# BeatSync Pro

Next.js app that analyzes an audio track for beats and renders a beat-synced video with FFmpeg.

## Prerequisites

- Node.js 18+
- Python 3.9+
- FFmpeg available in `PATH`

Install Python dependencies used by `python/beat.py`:

```bash
pip install librosa numpy soundfile
```

## Install and run

```bash
npm install
npm run dev
```

App runs on `http://localhost:3000`.

## 🚀 Déploiement sur le Web (Options gratuites)

### 🥇 **Option 1 : Render (Recommandé - 750h gratuites/mois)**

```bash
# Déploiement ultra-simple :
./deploy-render.sh

# Puis va sur https://render.com et suis les instructions
```

**Avantages :**
- ✅ **750 heures gratuites/mois** (environ 1 mois complet)
- ✅ **Python + Node.js** supportés
- ✅ **FFmpeg** disponible
- ✅ **Déploiement automatique** depuis GitHub
- ✅ **Stockage persistant** gratuit

### 🥈 **Option 2 : Fly.io (256MB RAM gratuit)**

```bash
# Installation et déploiement :
curl -L https://fly.io/install.sh | sh
source ~/.zshrc
./deploy-fly.sh
```

**Avantages :**
- ✅ **256MB RAM gratuit** (suffisant pour BeatSync)
- ✅ **160GB bandwidth gratuit/mois**
- ✅ **Régions mondiales** (CDG pour Europe)
- ✅ **Docker support** complet

### 🥉 **Option 3 : Railway (Si tu veux payer $5)**

```bash
railway login
./deploy-railway.sh
```

**Avantages :**
- ✅ **Python + Node.js** parfaits
- ✅ **Stockage illimité** après paiement
- ✅ **Performance optimale**

### 📱 **Option 4 : PWA (App mobile dans le navigateur)**

Ton app peut s'installer comme une app mobile :

```javascript
// Dans next.config.js, ajoute :
const withPWA = require('next-pwa')({
  dest: 'public'
})

module.exports = withPWA({
  // config existante
})
```

**Résultat :** Les utilisateurs peuvent "installer" ton app depuis leur navigateur mobile !

## 🎯 **Comparatif des options gratuites :**

| Service | Heures gratuites | RAM | Stockage | Complexité |
|---------|------------------|-----|----------|------------|
| **Render** | 750h/mois | 512MB | 1GB | ⭐⭐⭐ |
| **Fly.io** | Illimité | 256MB | 1GB | ⭐⭐⭐⭐ |
| **Railway** | 512h/mois | 512MB | 1GB | ⭐⭐⭐⭐⭐ |

**Recommandation :** Commence par **Render** - c'est le plus simple ! 🚀

## API flow

The API is job-scoped. Call endpoints in this order.

1. `POST /api/analyze`
2. `POST /api/render`
3. `GET /api/video?jobId=<uuid>`

### 1) Analyze

`POST /api/analyze` (multipart/form-data)

Required fields:
- `video`: video file (`video/*`)
- `audio`: audio file (`audio/*`)

Response:

```json
{
  "jobId": "uuid",
  "beats": [0.09, 0.58, 1.09]
}
```

### 2) Render

`POST /api/render` (`application/json`)

Body:

```json
{
  "jobId": "uuid",
  "mode": "FAST",
  "beats": [0.09, 0.58, 1.09]
}
```

Notes:
- `mode` supports `FAST` and `FLOW`.
- `beats` must be sorted ascending and contain at least 2 values.

Response:

```json
{
  "video": "/api/video?jobId=<uuid>"
}
```

### 3) Fetch output video

`GET /api/video?jobId=<uuid>`

Returns `video/mp4` when rendering is complete.

## Validation and limits

- Audio max size: 30 MB
- Video max size: 200 MB
- Invalid payloads return structured JSON errors with proper status codes.

You can override limits with environment variables:

```bash
BEATSYNC_MAX_AUDIO_MB=60
BEATSYNC_MAX_VIDEO_MB=500
```

## Temp jobs and cleanup

- Job files are stored in temp folders under a per-job UUID directory.
- Stale jobs are cleaned up opportunistically during API requests.

## Reproducible smoke test

Generate synthetic fixtures and run the full flow:

```bash
mkdir -p /tmp/beatsync-e2e
ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=30 -t 8 -pix_fmt yuv420p /tmp/beatsync-e2e/video.mp4
ffmpeg -y -f lavfi -i "aevalsrc='sin(2*PI*220*t)*if(lt(mod(t,0.5),0.06),1,0)':s=44100:d=8" /tmp/beatsync-e2e/audio-beat.wav

curl -sS -X POST http://localhost:3000/api/analyze \
  -F "video=@/tmp/beatsync-e2e/video.mp4;type=video/mp4" \
  -F "audio=@/tmp/beatsync-e2e/audio-beat.wav;type=audio/wav" > /tmp/beatsync-e2e/analyze.json

node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/tmp/beatsync-e2e/analyze.json','utf8'));fs.writeFileSync('/tmp/beatsync-e2e/jobId.txt',j.jobId);fs.writeFileSync('/tmp/beatsync-e2e/beats.json',JSON.stringify(j.beats));"

JOB_ID=$(cat /tmp/beatsync-e2e/jobId.txt)
BEATS_JSON=$(cat /tmp/beatsync-e2e/beats.json)

curl -sS -X POST http://localhost:3000/api/render \
  -H "content-type: application/json" \
  -d "{\"jobId\":\"$JOB_ID\",\"mode\":\"FAST\",\"beats\":$BEATS_JSON}" \
  > /tmp/beatsync-e2e/render.json

VIDEO_PATH=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('/tmp/beatsync-e2e/render.json','utf8'));console.log(j.video || j.url)")

curl -sS -o /tmp/beatsync-e2e/final.mp4 "http://localhost:3000$VIDEO_PATH"
```

You should get a non-empty `/tmp/beatsync-e2e/final.mp4`.
