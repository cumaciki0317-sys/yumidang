import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// 실제 Android 실행 검사다. 데이터 초기화·기존 앱 삭제·실제 회원 API는 사용하지 않는다.
const adb = process.env.ADB_EXECUTABLE || "/Users/b/Library/Android/sdk/platform-tools/adb";
const serial = process.env.ANDROID_SERIAL || "emulator-5554";
const base = process.env.ANDROID_EXPO_URL || "exp://10.0.2.2:8081";
const output = process.env.ANDROID_EVIDENCE_DIR || "/private/tmp/yumidang-android-runtime";
const app = "host.exp.exponent";
const run = (...args) => execFileSync(adb, ["-s", serial, ...args], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log("PASS", name); };
const xml = () => {
  run("shell", "uiautomator", "dump", "/sdcard/yumidang-runtime-window.xml");
  return run("exec-out", "cat", "/sdcard/yumidang-runtime-window.xml").toString();
};
const waitFor = async (label, accept) => {
  const until = Date.now() + 30000;
  let result = "";
  while (Date.now() < until) {
    result = xml();
    if (accept(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`${label}: Android 화면 확인 시간 초과`);
};
const open = route => {
  const result = run("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", route ? `${base}/--/${route}` : base, app).toString();
  console.log(result.trim());
  return result;
};
const stop = async () => {
  run("shell", "am", "force-stop", app);
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { run("shell", "pidof", app); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("이전 Expo Go 프로세스 종료 대기 실패");
};
const coldOpen = async () => {
  await stop();
  run("shell", "am", "start", "-W", "-n", `${app}/.LauncherActivity`);
  await new Promise(resolve => setTimeout(resolve, 2500));
  open("");
  await new Promise(resolve => setTimeout(resolve, 6000));
};
const evidence = async (name, screen) => {
  await writeFile(path.join(output, `${name}.xml`), screen);
  await writeFile(path.join(output, `${name}.png`), run("exec-out", "screencap", "-p"));
};
await mkdir(output, { recursive: true });
check("Android 부팅 완료", run("shell", "getprop", "sys.boot_completed").toString().trim() === "1");
check("실제 Expo Go SDK57 설치", /versionName=57\./.test(run("shell", "dumpsys", "package", app).toString()));
await coldOpen();
let screen = await waitFor("홈", value => value.includes("이번 주 새로 시작한 행사"));
check("Expo Go 콜드 실행 후 프로젝트 홈 표시", screen.includes("디자인 미리보기 · 예시 데이터") && screen.includes("마이페이지"));
const statusBounds = run("shell", "dumpsys", "window", "displays").toString().match(/type=statusBars frame=\[0,0\]\[\d+,(\d+)\]/);
const banner = [...screen.matchAll(/<node\b[^>]*>/g)].map(match => match[0]).find(node => /text="디자인 미리보기 · 예시 데이터"/.test(node));
const bannerBounds = banner?.match(/bounds="\[\d+,(\d+)\]\[\d+,\d+\]"/);
assert.ok(statusBounds && bannerBounds, "상태표시줄과 예시 배너의 실제 영역");
check("배너 글자가 상태표시줄 아래에 표시", +bannerBounds[1] >= +statusBounds[1]);
await evidence("cold-home", screen);
open("post?id=post-2");
screen = await waitFor("공고", value => value.includes("동행인은 로그인 후 확인할 수 있어요"));
check("비로그인 공고가 로그인 안내 표시", screen.includes("동행인은 로그인 후 확인할 수 있어요"));
check("비로그인 화면 XML에 실제 이름·상세 지점 없음", !screen.includes("박수빈") && !screen.includes("종합안내 데스크 앞"));
await evidence("anonymous-post", screen);
open("signup");
screen = await waitFor("가입", value => value.includes("가입 완료"));
const button = [...screen.matchAll(/<node\b[^>]*>/g)].map(match => match[0]).find(node => /(?:text|content-desc)="가입 완료"/.test(node));
assert.ok(button, "가입 완료 버튼 위치");
const coords = button.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
assert.ok(coords, "가입 완료 좌표");
run("shell", "input", "tap", String(Math.round((+coords[1] + +coords[3]) / 2)), String(Math.round((+coords[2] + +coords[4]) / 2)));
screen = await waitFor("사진 필수", value => value.includes("프로필 사진을 선택해 주세요"));
check("사진 없이 예시 가입 완료 차단", screen.includes("프로필 사진을 선택해 주세요"));
await evidence("required-photo", screen);
await coldOpen();
screen = await waitFor("재실행 홈", value => value.includes("이번 주 새로 시작한 행사"));
check("Expo Go 재실행 후 프로젝트 다시 열기 정상", screen.includes("디자인 미리보기 · 예시 데이터"));
const pid = run("shell", "pidof", app).toString().trim();
assert.match(pid, /^\d+$/);
const logs = run("logcat", "-d", `--pid=${pid}`, "ReactNativeJS:E", "AndroidRuntime:E", "*:S").toString();
check("현재 앱 프로세스 JS·Android 치명 오류 없음", !/FATAL EXCEPTION|ReactNativeJS.*(?:Error:|Exception:)/.test(logs));
await writeFile(path.join(output, "runtime-errors.log"), logs);
await writeFile(path.join(output, "result.json"), JSON.stringify({ result: "PASS", checks, serial, dataMode: "preview", memberApi: "NOT_RUN", nativeAuth: "NOT_RUN", photoCodec: "NOT_RUN", evidence: output }, null, 2));
console.log(JSON.stringify({ result: "PASS", checks: checks.length, evidence: output, dataMode: "preview", memberApi: "NOT_RUN" }));
