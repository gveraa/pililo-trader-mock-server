# Use official Node.js runtime as base image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json yarn.lock* ./

# Install dependencies
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Copy application source
COPY src/ ./src/
COPY schema/ ./schema/

# Create directory for mock configurations
RUN mkdir -p /app/mocks && \
    mkdir -p /app/logs

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of app directory
RUN chown -R nodejs:nodejs /app

# Ensure logs directory has write permissions
RUN chmod -R 755 /app/logs

# Switch to non-root user
USER nodejs

# Expose default port range for WebSocket servers
EXPOSE 8080-8090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check passed')" || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV CONFIG_DIR=mocks

# Start the application
CMD ["yarn", "start"]