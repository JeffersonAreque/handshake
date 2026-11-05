# Playwright image: Chromium and its system libraries are preinstalled.
# The tag must match the exact "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PORT=10000 \
    DATA_DIR=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public

# Fail the build early if the libsql native client can't load on this image.
RUN node -e "import('@libsql/client').then(() => console.log('libsql ok, node', process.version))"

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 10000
CMD ["node", "src/server.js"]
