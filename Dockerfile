# Utiliser l'image Node.js officielle
FROM node:20-alpine

# Installer Python et les dépendances système
RUN apk add --no-cache python3 py3-pip ffmpeg

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