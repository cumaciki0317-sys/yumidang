import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../../apps/mobile/src/api.ts";
import { validateOriginalPhoto, replacePhoto, reconcilePhoto, createPhotoStoragePort, createMemberReportCaptureUpload, createPrivateStorage, cancelMemberReportCapture, jpegHasExif, stripJpegMetadata, type PhotoStoragePort } from "../../../apps/mobile/src/avatar-service.ts";
import type { MemberService } from "../../../apps/mobile/src/member-service.ts";
const user = "11111111-1111-4111-8111-111111111111", image = "22222222-2222-4222-8222-222222222222", path = `${user}/${image}.jpg`;
// Marker fixture only; tests below do not claim a real image decoder/device run.
const jpeg = new Uint8Array([255,216,255,192,0,3,1,255,218,0,6,1,2,3,4,20,255,217]);
const input = { uri: "file:///photo.jpg", mimeType: "image/jpeg", originalBytes: 10_000_000 };
test("iOS 재인코드 APP1/APP13/주석만 제거하고 JPEG 화소 구간 보존", () => {
  const metadata = [255,225,0,5,69,120,105,255,237,0,4,80,83,255,254,0,4,65,66];
  const encoded = new Uint8Array([...jpeg.slice(0,2), ...metadata, ...jpeg.slice(2)]);
  assert.equal(jpegHasExif(encoded), true);
  assert.deepEqual(stripJpegMetadata(encoded), jpeg);
  assert.equal(jpegHasExif(stripJpegMetadata(encoded)), false);
});
test("스캔 뒤 metadata 제거에서도 FF00/restart 화소 바이트 유지", () => {
  const pixels = [50,255,0,225,255,208,60];
  const clean = new Uint8Array([...jpeg.slice(0,-2), ...pixels,255,217]);
  const encoded = new Uint8Array([...jpeg.slice(0,-2), ...pixels,255,225,0,4,69,120,255,217]);
  assert.deepEqual(stripJpegMetadata(encoded), clean);
  for (const malformed of [encoded.slice(0,-1),new Uint8Array([255,216,255,225,255,255]),new Uint8Array([255,216,255,218,0,4,1,2,255,217])]) {
    assert.throws(()=>stripJpegMetadata(malformed),error=>error instanceof ApiError && error.code==="INVALID_PHOTO");
  }
});
function storage() { const effects: string[] = []; const port: PhotoStoragePort = { encode: async () => ({ bytes: jpeg, mimeType: "image/jpeg" }), upload: async p => { effects.push(`upload:${p}`); }, remove: async p => { effects.push(`remove:${p}`); }, display: async () => "data:image/jpeg;base64," }; return { port, effects }; }
test("원본 decimal 10MB 정확 경계와 원격URI 거절", () => {
  validateOriginalPhoto(input);
  assert.throws(() => validateOriginalPhoto({ ...input, originalBytes: 10_000_001 }));
  assert.throws(() => validateOriginalPhoto({ ...input, uri: "https://unapproved.example/photo" }));
  assert.throws(() => validateOriginalPhoto({ ...input, originalBytes: 0 }));
});
test("EXIF/미완성 JPEG header는 업로드 대상이 아님", () => {
  assert.equal(jpegHasExif(jpeg), false); assert.equal(jpegHasExif(new Uint8Array([255,216,255,218])), true);
  assert.equal(jpegHasExif(new Uint8Array([255,216,255,225,0,2,255,217])), true);
});
test("불확실 swap과 이전 pointer 조회는 새 object 삭제 허가가 아님", async () => {
  const { port, effects } = storage();
  const service = { avatar: async () => { throw new ApiError(408, "REQUEST_TIMEOUT"); }, profile: async () => ({ userId: user, avatarUrl: `${user}/${user}.jpg` }) } as unknown as MemberService;
  await assert.rejects(replacePhoto(input, path, user, port, service, new AbortController().signal), { code: "PHOTO_SWAP_UNCERTAIN" });
  assert.deepEqual(effects, [`upload:${path}`]); assert.equal((await reconcilePhoto(path, user, service, new AbortController().signal)).status, "pending");
});
test("swap 응답소실 뒤 실제 pointer 채택확인만 성공이며 이전object 삭제추정 없음", async () => {
  const { port, effects } = storage();
  const service = { avatar: async () => { throw new ApiError(408, "REQUEST_TIMEOUT"); }, profile: async () => ({ userId: user, avatarUrl: path }) } as unknown as MemberService;
  assert.equal((await replacePhoto(input, path, user, port, service, new AbortController().signal)).avatarPath, path);
  assert.deepEqual(effects, [`upload:${path}`]);
});
test("새사진 성공과 이전사진 정리 실패를 구분", async () => {
  const { port } = storage(); port.remove = async () => { throw new ApiError(503, "STORAGE_REQUEST_FAILED"); };
  const service = { avatar: async () => ({ previousPath: `${user}/${user}.jpg` }), profile: async () => ({ userId: user, avatarUrl: path }) } as unknown as MemberService;
  const result = await replacePhoto(input, path, user, port, service, new AbortController().signal);
  assert.equal(result.avatarPath, path); assert.equal(result.cleanupPending, true);
});
test("Storage는 create-only JWT binary 전송, 고정 버킷, 공개URL없음", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const port = createPrivateStorage({ supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", accessToken: async () => "member", fetcher: async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(jpeg); } });
  await port.upload("profile-images", path, jpeg, "image/jpeg", new AbortController().signal);
  assert.equal((calls[0].init.headers as Record<string,string>)["x-upsert"], "false"); assert.equal(calls[0].init.method, "POST");
  await port.download("profile-images", path, new AbortController().signal); assert.match(calls[1].url, /\/object\/authenticated\/profile-images\//);
  assert.throws(() => createPrivateStorage({ supabaseUrl: "https://project.example", publicApiKey: "sb_secret_bad", accessToken: async () => "member" }));
});
test("늦은 Storage 응답은 부모취소 후 사용하지 않음", async () => {
  const controller = new AbortController();
  const port = createPrivateStorage({ supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", accessToken: async () => "member", fetcher: async () => { controller.abort(); return new Response(jpeg); } });
  await assert.rejects(port.download("profile-images", path, controller.signal));
});
test("캡처취소는 assetId와 다른 path를 삭제하지 않음", async () => {
  let called = false;
  const service = { cancelReportCapture: async () => { called = true; return {}; } } as unknown as MemberService;
  await assert.rejects(cancelMemberReportCapture(image, `${user}/${user}.jpg`, service, { supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", accessToken: async () => "member" }, new AbortController().signal));
  assert.equal(called, false);
});
test("대표사진 create-only 재시도 충돌은 동일한 저장bytes로만 복구", async () => {
  let count = 0;
  const options = { supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", accessToken: async () => "member", fetcher: async (_url: string | URL | Request, init?: RequestInit) => { count++; return init?.method === "POST" ? new Response(null, { status: 409 }) : new Response(jpeg); } };
  await createPhotoStoragePort(options).upload(path, jpeg, new AbortController().signal); assert.equal(count, 2);
  const different = { ...options, fetcher: async (_url: string | URL | Request, init?: RequestInit) => init?.method === "POST" ? new Response(null, { status: 409 }) : new Response(new Uint8Array([1,2,3])) };
  await assert.rejects(createPhotoStoragePort(different).upload(path, jpeg, new AbortController().signal));
});
test("일반 신고캡처는 예약→회원binary업로드→확인 순서이며 같은 UUID 유지", async () => {
  const effects: string[] = [];
  const service = { reserveReportCapture: async (id: string) => { effects.push(`reserve:${id}`); return { path: `${user}/${image}.jpg`, state: "reserved" }; }, confirmReportCapture: async (id: string) => { effects.push(`confirm:${id}`); return { assetId: id, state: "uploaded" }; } } as unknown as MemberService;
  const upload = createMemberReportCaptureUpload({ supabaseUrl: "https://project.example", publicApiKey: "sb_publishable_test", accessToken: async () => "member", fetcher: async () => { effects.push("upload"); return new Response(null); } }, service);
  assert.deepEqual(await upload({ asset: { uri: "blob:photo", mimeType: "image/jpeg", fileSize: jpeg.length, file: new Blob([jpeg]) }, assetId: image, userId: user, signal: new AbortController().signal }), { assetId: image });
  assert.deepEqual(effects, [`reserve:${image}`, "upload", `confirm:${image}`]);
});
