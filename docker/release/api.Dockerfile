FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build --workspace=@silverline/shared && npm run build --workspace=apps/api
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3101 UPLOADS_DIR=/data/uploads REPORTS_DIR=/data/exports
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace=apps/api --workspace=packages/shared && mkdir -p /data/uploads /data/exports && chown -R node:node /data
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
USER node
EXPOSE 3101
CMD ["node","apps/api/dist/main.js"]
