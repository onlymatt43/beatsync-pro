# Utiliser l'image Node.js officielle
FROM node:18-alpine

# Installer Python et les dépendances système
RUN apk add --no-cache python3 py3-pip ffmpeg

# Créer le répertoire de l'application
WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./
COPY requirements.txt ./

# Installer les dépendances Node.js
RUN npm ci

# Installer les dépendances Python
RUN pip3 install --no-cache-dir -r requirements.txt

# Copier le reste des fichiers
COPY . .

# Build l'application Next.js
RUN npm run build

# Exposer le port
EXPOSE 3000

# Commande de démarrage
CMD ["npm", "start"]