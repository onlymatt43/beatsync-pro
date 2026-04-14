# Utiliser une base Debian (glibc) pour récupérer les wheels Python précompilées
# de scipy/numba/opencv et éviter les builds source instables sur Alpine.
FROM node:20-bookworm-slim

# Installer Python et ffmpeg
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-venv python3-pip ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

# Utiliser un environnement virtuel Python pour éviter l'erreur PEP 668
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Créer le répertoire de l'application
WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./
COPY requirements.txt ./

# Installer les dépendances Node.js
RUN npm ci

# Installer les dépendances Python
RUN pip install --no-cache-dir -r requirements.txt

# Copier le reste des fichiers
COPY . .

# Build l'application Next.js
RUN npm run build

# Exposer le port
EXPOSE 3000

# Commande de démarrage
CMD ["npm", "start"]