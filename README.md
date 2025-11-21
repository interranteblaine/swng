## Development

### Common Commands

```bash
# Install dependencies
pnpm install                                    # Install all packages
pnpm -F domain add lodash                       # Add dependency to domain
pnpm -F domain add -D vitest                    # Add dev dependency to domain
pnpm add -Dw eslint                             # Add dev tool to root

# Run scripts
pnpm -F domain run dev                          # Run dev in domain
pnpm -F domain run build                        # Build domain
pnpm -F domain run test                         # Test domain

# Multiple packages
pnpm --parallel -F api -F web run dev           # Run dev servers in parallel
pnpm -r run build                               # Build all packages in apps/* and packages/*

# Validation
pnpm validate                                   # Run lint + build + test (before commit/push/deploy)

# Update/remove
pnpm -F domain update                           # Update domain dependencies
pnpm -F domain remove lodash                    # Remove dependency from domain

# Clean
pnpm -r exec rm -rf node_modules dist           # Delete node_modules and dist in all apps/* and packages/*

# Generate new package
pnpm gen new my-package                         # Scaffold new package from template in packages/
```
