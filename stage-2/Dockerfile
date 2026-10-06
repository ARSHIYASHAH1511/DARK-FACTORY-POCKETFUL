FROM node:24-alpine
WORKDIR /app
COPY . .
CMD ["sh", "-c", "node src/test.ts && node src/stress-test.ts"]
