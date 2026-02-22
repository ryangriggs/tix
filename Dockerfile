FROM node:20-alpine

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY views/ ./views/

RUN mkdir -p /app/data/uploads

EXPOSE 3000 25

CMD ["node", "src/app.js"]
