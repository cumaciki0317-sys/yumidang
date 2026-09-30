/** 종현 기능의 명시 운영 설정 읽기. 누락값에 운영 기본값을 만들지 않고 값·키 원문을 오류에 넣지 않는다. */
import type { EnvReader } from "../config/env.ts";

export class SettingError extends Error {
  constructor() { super("SETTING_NOT_CONFIGURED"); this.name = "SettingError"; }
}
export function requiredPositiveInt(read: EnvReader, key: string, maximum = 2_147_483_647): number {
  let value: string | undefined;
  try { value = read(key); } catch { throw new SettingError(); }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new SettingError();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new SettingError();
  return number;
}
/** 설정되지 않았으면 undefined. 설정됐지만 형식이 틀리면 조용히 무시하지 않고 오류다. */
export function optionalToken(read: EnvReader, key: string, pattern = /^[A-Za-z0-9_.:-]{1,64}$/): string | undefined {
  let value: string | undefined;
  try { value = read(key); } catch { throw new SettingError(); }
  if (value === undefined || value === "") return undefined;
  if (!pattern.test(value)) throw new SettingError();
  return value;
}
export function requiredToken(read: EnvReader, key: string, pattern?: RegExp): string {
  const value = optionalToken(read, key, pattern);
  if (value === undefined) throw new SettingError();
  return value;
}
