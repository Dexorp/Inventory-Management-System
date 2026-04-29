FROM node:20-bookworm

WORKDIR /app

RUN mkdir -p src /app/tenant-app-deploy

RUN apt-get update && apt-get install -y curl tar gzip && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://get.helm.sh/helm-v3.15.4-linux-amd64.tar.gz -o /tmp/helm.tar.gz \
  && tar -xzf /tmp/helm.tar.gz -C /tmp \
  && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
  && chmod +x /usr/local/bin/helm \
  && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

COPY package*.json ./
RUN npm ci


COPY . .

CMD ["node", "operator.js"]