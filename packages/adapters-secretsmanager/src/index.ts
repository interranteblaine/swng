// The package's one public interface (conventions §2) — consumers (lambda, its composition
// root) import "@swng/adapters-secretsmanager", never a deep path.
export { createSecretsManagerReader } from "./createSecretsManagerReader.js";
