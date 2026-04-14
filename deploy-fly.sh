#!/bin/bash

echo "🚀 Déploiement de BeatSync PRO sur Fly.io (Gratuit 256MB)"
echo ""

# Vérifier si flyctl est installé
if ! command -v flyctl &> /dev/null; then
    echo "❌ Fly.io CLI n'est pas installé."
    echo "Installe-le avec : curl -L https://fly.io/install.sh | sh"
    exit 1
fi

echo "🔑 Connexion à Fly.io..."
flyctl auth login

echo "📦 Création de l'app..."
flyctl launch --name beatsync-pro --region cdg --no-deploy

echo "⚙️ Configuration de l'app..."
cat > fly.toml << EOF
app = "beatsync-pro"
kill_signal = "SIGINT"
kill_timeout = 5
processes = []

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"

[experimental]
  allowed_public_ports = []
  auto_rollback = true

[[services]]
  http_checks = []
  internal_port = 8080
  processes = ["app"]
  protocol = "tcp"
  script_checks = []

  [services.concurrency]
    hard_limit = 25
    soft_limit = 20
    type = "connections"

  [[services.ports]]
    force_https = true
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  [[services.tcp_checks]]
    grace_period = "1s"
    interval = "15s"
    restart_limit = 0
    timeout = "2s"
EOF

echo "🚀 Déploiement..."
flyctl deploy

echo ""
echo "✅ Déploiement terminé !"
echo "🌐 Ton app sera disponible sur : https://beatsync-pro.fly.dev"
echo ""
echo "💡 Fly.io offre 256MB RAM gratuit + 160GB bandwidth/mois"