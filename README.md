## Development

Prereqs

- Node 20+, pnpm 8+
- AWS CLI configured (profile: swng, region: us-east-1)

Install

- pnpm install

Local development

- Web app (Vite):
  - Start dev: pnpm dev:web (http://localhost:5173)
- Validate before commit/push/deploy:
  - pnpm validate # lint + build + test

Scaffold a new package

- Quick shortcut to create a package under packages with sensible defaults:
  - pnpm gen new my-package

Backend (AWS CDK)

- First-time account setup (one-time per account/region):
  - pnpm cdk:bootstrap:beta
  - pnpm cdk:deploy:account # API Gateway account-level resources
- Beta environment:
  - Diff: pnpm cdk:diff:beta
  - Deploy: pnpm cdk:deploy:beta # writes outputs to apps/infra-cdk/cdk-outputs-beta.json
- Prod environment:
  - Diff: pnpm cdk:diff:prod
  - Deploy: pnpm cdk:deploy:prod # writes outputs to apps/infra-cdk/cdk-outputs-prod.json
- Safety wrapper (ensures AWS_PROFILE is set):
  - pnpm cdk:deploy:safe

Endpoints

- After a deploy, HTTP and WebSocket endpoints are in:
  - apps/infra-cdk/cdk-outputs-beta.json (beta)
  - apps/infra-cdk/cdk-outputs-prod.json (prod)
  - Look for HttpApiUrl-<stage> and WsWssUrl-<stage>

Smoke test (end-to-end verify)

- Verify deployed endpoints using the node client:
  - pnpm -F @swng/node-client run verify --api <HTTP base URL> --ws <WSS URL>

Web app deploy (S3 + CloudFront)

- Build for target stage:
  - Beta: pnpm build:web:beta
  - Prod: pnpm build:web:prod
- Publish static site and invalidate CloudFront:
  - Beta: pnpm run web:publish:beta
  - Prod: pnpm run web:publish:prod
- The publish script discovers S3/CloudFront via CloudFormation exports created by the CDK stacks.
