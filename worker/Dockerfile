# Optional: run Playwright lookups off Vercel (Vercel functions are short-lived). Deploy to a €6 VPS; point BROWSERBASE_API_KEY or call these routes from here.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["npx","tsx","worker/index.ts"]
