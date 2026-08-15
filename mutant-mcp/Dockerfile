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
ENV AWS_LWA_INVOKE_MODE=response_stream
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.mjs"]
