import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// Prod-readiness hardening Arc A, Task 4: the token-signing secret moves from a plaintext
// Lambda env var to a runtime Secrets Manager fetch, out of the reach of anyone with only
// lambda:GetFunctionConfiguration. AWS SDKs are importable only inside adapters
// (eslint.config.mjs) — lambda's composition root wires the secret's ARN into this factory
// but must never import @aws-sdk/client-secrets-manager itself. Mirrors adapters-dynamodb's
// createDocumentClient / adapters-apigateway's createManagementClient: the SDK client's
// construction (and, here, the one GetSecretValueCommand call) stays inside this package.
//
// The client is built ONCE per factory call — compositionRoot.ts's buildApp calls this at
// most once per cold start (each entry caches its buildApp Promise), so this reuses the same
// client the way createDocumentClient()/createManagementClient() do for their own SDKs.
export const createSecretsManagerReader = (): ((arn: string) => Promise<string>) => {
  const client = new SecretsManagerClient({});
  return async (arn: string): Promise<string> => {
    const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!out.SecretString) throw new Error(`createSecretsManagerReader: secret ${arn} resolved no SecretString`);
    return out.SecretString;
  };
};
