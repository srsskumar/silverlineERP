FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm ci && npm run build --workspace=@silverline/shared && npm run build --workspace=apps/web
FROM caddy:2
COPY docker/release/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/out /srv
