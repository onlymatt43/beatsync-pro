#!/bin/bash

echo "🚀 Déploiement de BeatSync PRO sur Railway"
echo ""

# Vérifier si Railway CLI est installé
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI n'est pas installé. Installe-le avec : npm install -g @railway/cli"
    exit 1
fi

# Se connecter à Railway
echo "🔑 Connexion à Railway..."
railway login

# Créer un nouveau projet
echo "📦 Création du projet..."
railway init beatsync-pro

# Déployer
echo "🚀 Déploiement en cours..."
railway up

echo ""
echo "✅ Déploiement terminé !"
echo "🌐 Ton app sera disponible sur l'URL fournie par Railway"
echo ""
echo "📝 Note : La première fois peut prendre plusieurs minutes"
echo "   car Railway doit installer toutes les dépendances Python."