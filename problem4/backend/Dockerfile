# syntax=docker/dockerfile:1
# Backend API image. Build stage installs and compiles; the runtime stage only
# carries production dependencies and the build output, and runs as non-root.

FROM node:24-alpine AS build
WORKDIR /app
# Same pnpm major as CI; corepack would fetch whatever pnpm is latest.
RUN npm install -g pnpm@10.34.9
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Numeric UID (the image's "node" user) so Kubernetes can enforce runAsNonRoot.
USER 1000
EXPOSE 3000
CMD ["node", "dist/server.js"]
