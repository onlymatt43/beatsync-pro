#!/bin/bash
cd "$(dirname "$0")"
echo "🎵 Lancement de la synchronisation musicale..."
source ../venv/bin/activate
python3 beat_sync_v2.py
echo " "
read -p "Appuie sur Entrée pour fermer..."