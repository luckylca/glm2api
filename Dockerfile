# GLM-2API Docker Image
# OpenAI/Anthropic compatible API proxy using GLM web chat

FROM node:20-alpine

LABEL maintainer="GLM-2API"
LABEL description="GLM Web Chat to API proxy"

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source files
COPY src/ ./src/

# Create log directory (default location)
RUN mkdir -p /var/log/glm2api

# Environment defaults
ENV PORT=3099
ENV NODE_ENV=production
ENV LOG_DIR=/var/log/glm2api

# Expose port
EXPOSE 3099

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3099/healthz || exit 1

# Run the service
CMD ["node", "src/index.js"]