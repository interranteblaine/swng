#!/usr/bin/env bash
# Publish the built web app to S3 and invalidate CloudFront for a stage (default: beta)
# - Looks up resources via CloudFormation Exports (stable names with -beta suffix)
# - Applies strong caching to hashed assets and no-cache to index.html
# - Invalidates CloudFront so users see changes immediately
#
# Usage:
#   AWS_PROFILE=swng AWS_REGION=us-east-1 bash tools/web-publish-beta.sh [stage]
# Example:
#   bash tools/web-publish-beta.sh           # uses AWS_PROFILE or 'swng', region or 'us-east-1', stage 'beta'
#   bash tools/web-publish-beta.sh beta
#   bash tools/web-publish-beta.sh prod      # works if you have corresponding Exports for prod
set -euo pipefail

# Configuration (with sensible defaults)
PROFILE="${AWS_PROFILE:-swng}"
REGION="${AWS_REGION:-us-east-1}"
STAGE="${1:-beta}"

DIST_DIR="apps/web/dist"

echo "==> Web publish started"
echo "    Profile: ${PROFILE}"
echo "    Region : ${REGION}"
echo "    Stage  : ${STAGE}"
echo "    Dist   : ${DIST_DIR}"
echo

# Helper: fetch a CloudFormation export value by name
fetch_export() {
  local name="$1"
  aws cloudformation list-exports \
    --profile "${PROFILE}" \
    --region "${REGION}" \
    --query "Exports[?Name=='${name}'].Value" \
    --output text
}

# Resolve resources via CFN Exports (these export names are defined in the CDK stack)
BUCKET_EXPORT="UiBucketName-${STAGE}"
DIST_DOMAIN_EXPORT="UiDistributionDomainName-${STAGE}"

echo "==> Resolving CloudFormation exports"
BUCKET="$(fetch_export "${BUCKET_EXPORT}")"
DIST_DOMAIN="$(fetch_export "${DIST_DOMAIN_EXPORT}")"

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  echo "ERROR: Could not resolve export '${BUCKET_EXPORT}'. Is the stack deployed in ${REGION} for profile ${PROFILE}?"
  exit 1
fi
if [[ -z "${DIST_DOMAIN}" || "${DIST_DOMAIN}" == "None" ]]; then
  echo "ERROR: Could not resolve export '${DIST_DOMAIN_EXPORT}'. Is the stack deployed in ${REGION} for profile ${PROFILE}?"
  exit 1
fi

echo "    S3 Bucket        : ${BUCKET}"
echo "    CloudFront Domain: ${DIST_DOMAIN}"
echo

# Validations
if [[ ! -d "${DIST_DIR}" ]]; then
  echo "ERROR: Build output directory '${DIST_DIR}' not found."
  echo "       Run: pnpm run build:web:${STAGE}"
  exit 1
fi

INDEX_FILE="${DIST_DIR}/index.html"
if [[ ! -f "${INDEX_FILE}" ]]; then
  echo "ERROR: '${INDEX_FILE}' not found. Ensure the site was built."
  exit 1
fi

# Upload static assets (excluding index.html) with immutable caching
echo "==> Syncing assets (immutable cache) to s3://${BUCKET}"
aws s3 sync "${DIST_DIR}" "s3://${BUCKET}" \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --delete \
  --exclude "index.html" \
  --cache-control "max-age=31536000,public,immutable"

# Upload index.html with no-cache so browsers fetch updates
echo "==> Uploading index.html (no-cache) to s3://${BUCKET}/index.html"
aws s3 cp "${INDEX_FILE}" "s3://${BUCKET}/index.html" \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --content-type "text/html"

# Find CloudFront Distribution ID from DomainName and invalidate
echo "==> Resolving CloudFront distribution ID from domain: ${DIST_DOMAIN}"
DIST_ID="$(
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?DomainName=='${DIST_DOMAIN}'].Id | [0]" \
    --output text
)"

if [[ -z "${DIST_ID}" || "${DIST_ID}" == "None" ]]; then
  echo "ERROR: Could not resolve DistributionId for domain '${DIST_DOMAIN}'."
  exit 1
fi

echo "    Distribution ID: ${DIST_ID}"
echo "==> Creating CloudFront invalidation /*"
aws cloudfront create-invalidation \
  --distribution-id "${DIST_ID}" \
  --paths "/*" >/dev/null

SITE_URL_EXPORT="UiUrl-${STAGE}"
SITE_URL="$(fetch_export "${SITE_URL_EXPORT}" || true)"

echo
echo "==> Publish complete"
echo "    Bucket       : s3://${BUCKET}"
echo "    Distribution : ${DIST_ID} (${DIST_DOMAIN})"
if [[ -n "${SITE_URL}" && "${SITE_URL}" != "None" ]]; then
  echo "    Site URL     : ${SITE_URL}"
fi
echo "    Stage        : ${STAGE}"
