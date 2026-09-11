FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache postgresql-client

FROM base AS builder
COPY package*.json ./
COPY tsconfig.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci --workspaces --include-workspace-root

COPY . .
RUN npm run build --workspace=apps/api

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/packages/shared ./packages/shared
EXPOSE 8080
CMD ["node", "dist/main.js"]