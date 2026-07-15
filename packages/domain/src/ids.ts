declare const brandSymbol: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type GolferId = Brand<string, "GolferId">;
export type RoundId = Brand<string, "RoundId">;
export type GameId = Brand<string, "GameId">;
export type OpId = Brand<string, "OpId">;
export type DeviceId = Brand<string, "DeviceId">;
export type CourseId = Brand<string, "CourseId">;
export type CrewId = Brand<string, "CrewId">;
export type CardId = Brand<string, "CardId">;
export type TeeId = Brand<string, "TeeId">;

export const golferId = (value: string): GolferId => value as GolferId;
export const roundId = (value: string): RoundId => value as RoundId;
export const gameId = (value: string): GameId => value as GameId;
export const opId = (value: string): OpId => value as OpId;
export const deviceId = (value: string): DeviceId => value as DeviceId;
export const courseId = (value: string): CourseId => value as CourseId;
export const crewId = (value: string): CrewId => value as CrewId;
export const cardId = (value: string): CardId => value as CardId;
export const teeId = (value: string): TeeId => value as TeeId;
