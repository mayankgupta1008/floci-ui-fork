# Stage 1 — build frontend with a placeholder base
FROM node:20-alpine AS frontend-build
ENV FLOCI_UI_BASE_PATH=/__FLOCI_BASE__
WORKDIR /app
COPY packages/frontend/package.json ./
RUN npm install
COPY packages/frontend/ .
RUN npm run build

# Stage 2 — compile API to a self-contained binary
FROM oven/bun:1-alpine AS api-build
WORKDIR /app
COPY packages/api/package.json packages/api/bun.lock* ./
RUN bun install
COPY packages/api/src ./src
RUN bun build --compile --minify src/index.ts --outfile server

# Stage 3 — minimal runtime
FROM alpine:3
RUN apk add --no-cache ca-certificates libstdc++
WORKDIR /app
COPY --from=api-build /app/server ./server
COPY --from=frontend-build /app/dist ./public

COPY <<'EOF' /entrypoint.sh
#!/bin/sh
set -e
BASE="${FLOCI_UI_BASE_PATH:-/}"
[ "$BASE" = "/" ] && PREFIX="" || PREFIX="${BASE%/}"
find /app/public -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) \
  -exec sed -i "s|/__FLOCI_BASE__|${PREFIX}|g" {} +
exec "$@"
EOF
RUN chmod +x /entrypoint.sh

ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["./server"]
