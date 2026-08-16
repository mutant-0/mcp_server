# ---- build stage: compile TypeScript into a single self-contained bundle ----
FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run bundle

# ---- runtime stage: minimal image + Lambda Web Adapter ----
FROM public.ecr.aws/docker/library/node:22-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter
ENV PORT=8080
# Buffered invoke mode matches the HTTP API (v2) integration, which does not use
# InvokeWithResponseStream. Streaming mode would cause a 500 on every request.
ENV AWS_LWA_INVOKE_MODE=buffered
# Avoid the adapter's default HTTP GET / readiness probe, which the POST-only
# handler would reject and log as noise.
ENV AWS_LWA_READINESS_CHECK_PROTOCOL=tcp
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.mjs"]
