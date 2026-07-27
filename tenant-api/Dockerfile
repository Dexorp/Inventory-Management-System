FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better Docker layer caching
COPY package*.json ./

RUN npm ci --omit=dev

# Copy app source
COPY general-api.js ./general-api.js
COPY sidecar-apis ./sidecar-apis

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "general-api.js"]