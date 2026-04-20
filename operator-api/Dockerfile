# Small, production-friendly base
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy operator code
COPY operator.js ./

# Run as non-root for safety
USER node

# No ports needed (operator talks to K8s API internally)
CMD ["node", "operator.js"]