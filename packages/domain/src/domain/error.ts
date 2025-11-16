export class DomainError extends Error {
  readonly kind = "DomainError";

  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
