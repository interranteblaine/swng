import { describe, expect, it } from "vitest";
import { buildRoutes, type UseCases } from "@swng/lambda";
import { HTTP_ROUTES } from "../lib/swngStack.js";

// buildRoutes never calls into `useCases` while building the table — only a dispatched
// request reaches a handler — so a stub that satisfies the type (and throws if a handler
// somehow ran) is enough to read off the table's {method, path} shape without wiring any
// real port.
const stubUseCases: UseCases = {
  startRound: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
  joinRound: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
  addGame: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
  recordScore: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
  finalizeRound: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
  readEvents: () => {
    throw new Error("not implemented: parity test never dispatches");
  },
};

const sortKey = (route: { readonly method: string; readonly path: string }): string => `${route.method} ${route.path}`;

// The dispatcher (packages/lambda/src/http/routes.ts) and the CDK stack (lib/swngStack.ts)
// each hand-declare the same six-route table independently — swngStack.ts's own comment
// says "matching packages/lambda/src/http/routes.ts", but nothing enforced that until now.
// This pins the two tables together so a route added to one and forgotten in the other
// fails CI instead of 404ing (or silently never being reachable) in beta.
describe("route parity: CDK route table vs. the lambda dispatcher", () => {
  it("HTTP_ROUTES matches buildRoutes' {method, path} set exactly", () => {
    const dispatcherRoutes = buildRoutes(stubUseCases)
      .map((route) => ({ method: route.method as string, path: route.path }))
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

    const cdkRoutes = HTTP_ROUTES.map((route) => ({ method: route.method as string, path: route.path })).sort((a, b) =>
      sortKey(a) < sortKey(b) ? -1 : 1,
    );

    expect(dispatcherRoutes).toEqual(cdkRoutes);
  });
});
