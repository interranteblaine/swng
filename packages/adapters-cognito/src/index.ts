// The package's one public interface (conventions §2) — consumers (lambda, its tests)
// import "@swng/adapters-cognito", never a deep path.
export { createCognitoVerifier } from "./createCognitoVerifier.js";
export { createAccessTokenVerifier, accountVerifierFromAccessToken } from "./createAccessTokenVerifier.js";
export type { OAuthTokenVerifier, AuthInfo } from "./createAccessTokenVerifier.js";
