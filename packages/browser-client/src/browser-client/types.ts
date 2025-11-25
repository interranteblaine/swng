export interface GreetOptions {
  name: string;
  polite?: boolean;
}

export interface Greeter {
  greet(options: GreetOptions): string;
}
