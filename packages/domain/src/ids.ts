declare const brandSymbol: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type GolferId = Brand<string, "GolferId">;
export type RoundId = Brand<string, "RoundId">;
export type GameId = Brand<string, "GameId">;
export type OpId = Brand<string, "OpId">;
export type DeviceId = Brand<string, "DeviceId">;

export const golferId = (value: string): GolferId => value as GolferId;
export const roundId = (value: string): RoundId => value as RoundId;
export const gameId = (value: string): GameId => value as GameId;
export const opId = (value: string): OpId => value as OpId;
export const deviceId = (value: string): DeviceId => value as DeviceId;
