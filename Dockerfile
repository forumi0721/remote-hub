FROM node:20-alpine

# 타임존 및 필수 패키지 설정
RUN apk add --no-cache tzdata

WORKDIR /app

# 의존성 복사 및 설치 (캐싱 활용)
COPY package*.json ./
RUN npm ci --omit=dev

# 소스 및 정적 자산 복사
COPY src/ ./src/
COPY public/ ./public/

# 설정 파일 저장 볼륨 디렉터리 (기존 novnc-hub 호환 유지)
RUN mkdir -p /conf.d/remotehub /conf.d/novnc-hub
VOLUME ["/conf.d/remotehub"]

ENV PORT=8080
ENV CONFIG_PATH=/conf.d/remotehub/config.json
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const r=require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/api/status',timeout:3000},s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)})"

EXPOSE 8080

CMD ["node", "src/server.js"]
