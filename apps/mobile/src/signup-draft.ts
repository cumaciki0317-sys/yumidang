import type { PhotoInput } from "./avatar-service";

/** Process memory only. The trusted session installer must observe every epoch change. */
export interface SignupDraftScope { userId: string; epoch: number; session: object; }
export interface SignupDraft {
  photo: PhotoInput | null;
  avatarPath: string | null;
  interests: string[];
  conversationStyles: string[];
  mbti: string;
  uploaded: { path: string; ready: boolean } | null;
}
type Editable = "photo" | "interests" | "conversationStyles" | "mbti";
type ServerSignup = { avatarPath: string | null; interests: string[]; conversationStyles: string[]; mbti: string | null };
const empty = (): SignupDraft => ({ photo: null, avatarPath: null, interests: [], conversationStyles: [], mbti: "", uploaded: null });
const copy = (draft: SignupDraft): SignupDraft => ({ ...draft, photo: draft.photo ? { ...draft.photo } : null, interests: [...draft.interests], conversationStyles: [...draft.conversationStyles], uploaded: draft.uploaded ? { ...draft.uploaded } : null });
const same = (a: SignupDraftScope | null, b: SignupDraftScope | null) => !!a && !!b && a.userId === b.userId && a.epoch === b.epoch && a.session === b.session;

export function createSignupDraftStore() {
  let scope: SignupDraftScope | null = null;
  let draft = empty();
  const edited = new Set<Editable>();
  return {
    observe(next: SignupDraftScope | null) {
      if (!same(scope, next)) { scope = next ? { ...next } : null; draft = empty(); edited.clear(); }
    },
    read(expected: SignupDraftScope): SignupDraft | null { return same(scope, expected) ? copy(draft) : null; },
    edit(expected: SignupDraftScope, field: Editable, value: SignupDraft[Editable]): SignupDraft | null {
      if (!same(scope, expected)) return null;
      edited.add(field);
      if (field === "photo") { draft.photo = value ? { ...(value as PhotoInput) } : null; draft.avatarPath = null; draft.uploaded = null; }
      else if (field === "mbti") draft.mbti = value as string;
      else draft[field] = [...value as string[]];
      return copy(draft);
    },
    merge(expected: SignupDraftScope, server: ServerSignup): SignupDraft | null {
      if (!same(scope, expected)) return null;
      if (!edited.has("photo")) draft.avatarPath = server.avatarPath;
      if (!edited.has("interests")) draft.interests = [...server.interests];
      if (!edited.has("conversationStyles")) draft.conversationStyles = [...server.conversationStyles];
      if (!edited.has("mbti")) draft.mbti = server.mbti || "";
      return copy(draft);
    },
    upload(expected: SignupDraftScope, value: SignupDraft["uploaded"]): SignupDraft | null {
      if (!same(scope, expected)) return null;
      draft.uploaded = value ? { ...value } : null;
      return copy(draft);
    },
    clear(expected?: SignupDraftScope) {
      if (expected && !same(scope, expected)) return;
      scope = null; draft = empty(); edited.clear();
    },
  };
}
export const signupDraftStore = createSignupDraftStore();
/** No tokens are retained. Call synchronously on logout, ready, account/port and epoch changes. */
export const observeSignupDraftSession = (scope: SignupDraftScope | null) => signupDraftStore.observe(scope);
