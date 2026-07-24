import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createSecretsManagerReader } from "./createSecretsManagerReader.js";

// The SDK client is mocked (never a real network call in a unit test) — SecretsManagerClient's
// constructor is replaced, everything else from the real module (GetSecretValueCommand and
// friends) stays real, so `instanceof` checks below still hold.
const send = vi.fn();

vi.mock("@aws-sdk/client-secrets-manager", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-secrets-manager")>("@aws-sdk/client-secrets-manager");
  // A `function` (not an arrow) so `mockImplementation` produces something `new`-able —
  // SecretsManagerClient is always constructed with `new` in createSecretsManagerReader.ts.
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(function FakeSecretsManagerClient() {
      return { send };
    }),
  };
});

const secretArn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-beta";

describe("createSecretsManagerReader", () => {
  beforeEach(() => {
    send.mockReset();
    vi.mocked(SecretsManagerClient).mockClear();
  });

  it("issues a GetSecretValueCommand for the given ARN and returns its SecretString", async () => {
    send.mockResolvedValueOnce({ SecretString: "the-secret-value" });
    const readSecret = createSecretsManagerReader();

    const value = await readSecret(secretArn);

    expect(value).toBe("the-secret-value");
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]![0] as GetSecretValueCommand;
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect(command.input.SecretId).toBe(secretArn);
  });

  // A binary secret (or one somehow versioned with no string stage) resolves no SecretString —
  // this must surface as a clear error, never a silently-undefined signing key.
  it("throws a clear error when the secret resolves no SecretString", async () => {
    send.mockResolvedValueOnce({});
    const readSecret = createSecretsManagerReader();

    await expect(readSecret(secretArn)).rejects.toThrow(/resolved no SecretString/);
  });

  // buildApp calls this factory at most once per cold start (each entry caches its buildApp
  // Promise) — the client itself must be constructed once per factory call, not once per read,
  // mirroring createDocumentClient()/createManagementClient()'s own "one client, reused" shape.
  it("constructs the SDK client once per factory call, reused across repeated reads", async () => {
    send.mockResolvedValue({ SecretString: "v" });
    const readSecret = createSecretsManagerReader();

    await readSecret(secretArn);
    await readSecret(secretArn);

    expect(vi.mocked(SecretsManagerClient)).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
