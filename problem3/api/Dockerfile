# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Pinned pnpm, and a lockfile, so every build installs the same dependency tree.
RUN npm install -g pnpm@10.34.9
COPY package.json pnpm-lock.yaml ./
# Store in a build cache mount, so it never lands in the image layer.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
