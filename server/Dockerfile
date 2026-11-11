FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY src ./src
COPY entrypoint.sh ./
ENV NODE_ENV=production NODE_NO_WARNINGS=1 DATA_DIR=/data PORT=8743
USER node
EXPOSE 8743
CMD ["sh", "/app/entrypoint.sh"]
