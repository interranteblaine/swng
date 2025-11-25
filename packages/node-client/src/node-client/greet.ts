import type { GreetOptions, Greeter } from "./types";

export const defaultGreeter: Greeter = {
  greet(options: GreetOptions): string {
    const { name, polite = false } = options;

    if (polite) {
      return `Hello, ${name}.`;
    }

    return `Hey ${name}!`;
  },
};

export function greet(options: GreetOptions): string {
  return defaultGreeter.greet(options);
}
