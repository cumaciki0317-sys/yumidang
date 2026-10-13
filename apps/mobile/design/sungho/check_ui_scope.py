"""UI 범위 보조 검사. 공통 hook/권한을 변경하지 않는다."""
from pathlib import Path
import re
import sys
root = Path(__file__).resolve().parent
extracted = root / "html/extracted"
folders = [
 "유미당-홈-소스/yumidang-home", "유미당-둘러보기-소스/yumidang-browse",
 "유미당-공고상세-소스/yumidang-listing-detail", "유미당-S11-채팅-소스",
 "유미당-S09-2-행사목록-소스/list", "유미당-S09-3-행사상세-소스/detail",
 "유미당-나-S13-소스", "유미당-S05-로그인-소스/yumidang-S05",
 "유미당-S06-가입프로필-소스/yumidang-S06",
 "유미당-둘러보기-소스",
]
# 승인된 목록/상세 시트 이동만 예외. 그 외 파일에 라우팅을 추가하면 실패한다.
nav_allowed = {"유미당-둘러보기-소스/yumidang-browse/browse.js", "유미당-둘러보기-소스/browse-detail.js"}
failures = []
count = 0
for folder in folders:
 for path in (extracted / folder).glob("*.js"):
  if path.name.startswith(("test-", "validate_")): continue
  count += 1
  source = path.read_text(encoding="utf-8")
  rel = path.relative_to(extracted).as_posix()
  rules = [(r"\b(?:localStorage|sessionStorage|indexedDB)\b", "공유 저장소"),
           (r"\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(", "외부 연결")]
  if rel not in nav_allowed:
   rules += [(r"location\.(?:assign|replace)\s*\(|location\.href\s*=|history\.(?:pushState|replaceState|back)\s*\(", "앱 라우팅")]
  if path.name == "flow.js":
   rules += [(r"Date\.(?:now|parse)\s*\(|Math\.min\s*\(|setInterval\s*\(", "약속 업무 시간 계산")]
  for pattern, label in rules:
   if re.search(pattern, source): failures.append(f"{rel}: {label}")
for path in (root.parents[1] / "src/presentation/sungho").rglob("*.tsx"):
 if re.search(r"(?:from|import)\s*[('\"]+[^'\"]*(?:/state|/domain|/api|/remote|/service|/storage)", path.read_text(encoding="utf-8")):
  failures.append(f"{path.name}: 표시 컴포넌트의 서비스 의존")
if failures:
 print("UI 범위 확인 필요:\n" + "\n".join(failures)); sys.exit(1)
print(f"UI 범위 검사 통과: 활성 JS {count}개. 장면/표시 보존 검사는 화면별 테스트로 별도 수행.")
