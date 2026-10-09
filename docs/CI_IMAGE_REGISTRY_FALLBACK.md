# CI image registry fallback (2026-10-10)

The October 9 GitHub Actions jobs on commit `74e50ff0cc7daccb78dcfcfa9b65c6c958d99030` failed to initialize the PostgreSQL service and build Compose because Docker Hub returned HTTP 429 to unauthenticated clients. Go and security static tests passed on that commit. Those service-init failures do **not** demonstrate a passing Gateway/Odoo integration suite.

CI now requests Docker Official Images via Amazon ECR Public, while retaining the upstream exact tag **and manifest digest**, to avoid Docker Hub unauthenticated pull limits. This affects CI workflows and `docker-compose.ci.yml`; production compose and Dockerfile default references are unchanged. Dockerfile's `NODE_BASE_IMAGE` argument is overridden only by the CI compose overlay. The Dockerfile uses standard built-in Dockerfile syntax and does not fetch an external Dockerfile frontend from Docker Hub. If the Docker Official Image published by AWS does not expose the exact approved digest, the build will fail closed; investigate/pin the verified registry-specific digest rather than silently removing SHA verification.

Official background: https://www.docker.com/press-release/docker-official-images-available-amazon-elastic-container-registry/ and https://docs.aws.amazon.com/AmazonECR/latest/public/public-registries.html. Docker Hub rate-limit behavior: https://docs.docker.com/docker-hub/usage/pulls/.

CI is still required to run PostgreSQL migrations, real Odoo integration, Docker Compose health/security checks, Tauri/Windows builds, and the Go test suites on the new commit; they are not marked PASS merely because files changed. Windows service-account and real printer/paper tests remain separate on-site acceptance.
