export type ScreenId =
  | "S00"
  | "S01"
  | "S02"
  | "S03"
  | "S04"
  | "S05"
  | "S06"
  | "S09"
  | "S09-2"
  | "S09-3"
  | "S10"
  | "S11"
  | "S12"
  | "S13"
  | "S14"
  | "S15"
  | "S15-2"
  | "S16"
  | "S17"
  | "S18"
  | "S19"
  | "S20"
  | "S21";
export type Member = {
  id: string;
  name: string;
  age: number;
  photo: string;
  interests: string[];
  conversationStyles: string[];
  mbti: string;
  introduction: string;
  sweetness: number;
  completedCount: number;
};
export type Post = {
  id: string;
  authorId: string;
  title: string;
  introduction: string;
  category: string;
  placeName: string;
  publicArea: string;
  address: string;
  meetingPoint: string;
  startsAt: number;
  endsAt: number;
  createdAt: number;
  deadlineAt: number;
  status:
    | "recruiting"
    | "closed"
    | "awaiting_consent"
    | "confirmed"
    | "completed"
    | "deleted";
  eventId?: string;
  image?: string;
  desiredAgeMin?: string;
  desiredAgeMax?: string;
  wishes?: string;
};
export type EventItem = {
  id: string;
  title: string;
  category: string;
  placeName: string;
  publicArea: string;
  startsAt: number;
  endsAt: number;
  image: string;
  price: string;
  sourceName: string;
  sourceUrl?: string;
  description: string;
};
export type Message = {
  id: string;
  senderId: string;
  text: string;
  at: number;
};
export type Conversation = {
  id: string;
  postId: string;
  applicantId: string;
  status: "active" | "withdrawn" | "rejected" | "ended" | "confirmed";
  messages: Message[];
  requestAt?: number;
  requestExpiresAt?: number;
  withdrawnAt?: number;
  hiddenBy: string[];
  endedReason?: "recruitment" | "cancelled" | "deleted";
};
export type Appointment = {
  id: string;
  postId: string;
  hostId: string;
  applicantId: string;
  startsAt: number;
  endsAt: number;
  completedAt: number | null;
  confirmations: string[];
  status: "confirmed" | "completed" | "cancelled" | "disputed";
  disputeStartedAt?: number;
  reviewRemainingMs?: number;
  reviewDeadlineAt?: number;
  proposal?: {
    startsAt: number;
    endsAt: number;
    placeName: string;
    address: string;
    publicArea: string;
    meetingPoint: string;
    proposedBy: string;
    requestedAt: number;
    expiresAt: number;
  };
};
export type Review = {
  id: string;
  appointmentId: string;
  authorId: string;
  targetId: string;
  mood: "good" | "neutral" | "bad";
  stars: number;
  comment: string;
  praises: string[];
  submittedAt: number;
  publishedAt?: number;
  hidden: boolean;
  invalid: boolean;
};
export type Notification = {
  id: string;
  title: string;
  text: string;
  at: number;
  read: boolean;
  screen: ScreenId;
  targetId?: string;
};
export type Draft = {
  editingPostId?: string;
  category: string;
  title: string;
  introduction: string;
  placeName: string;
  publicArea: string;
  address: string;
  meetingPoint: string;
  startsAt: string;
  endsAt: string;
  deadlineAt: string;
  eventId?: string;
  desiredAgeMin: string;
  desiredAgeMax: string;
  wishes: string;
  updatedAt: number;
};
export type Filters = {
  query: string;
  category: string;
  region: string;
  from: string;
  to: string;
  ageMin: string;
  ageMax: string;
  recruiting: boolean;
  sort: "created_desc" | "starts_asc";
};
export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  postIds?: string[];
  eventIds?: string[];
  hidden?: boolean;
};
export type OperationResult = { ok: boolean; message?: string; id?: string };
export type AppState = {
  viewerId: string | null;
  members: Record<string, Member>;
  posts: Post[];
  events: EventItem[];
  conversations: Conversation[];
  appointments: Appointment[];
  reviews: Review[];
  notifications: Notification[];
  draft: Draft | null;
  recentSearches: { text: string; at: number }[];
  blockedIds: string[];
  aiMessages: AiMessage[];
  aiUsed: number;
  aiDay: string;
  aiBusy: boolean;
  aiDiscoveryAllowed: boolean;
  aiSummaryAllowed: boolean;
  aiSummaryWithdrawnIds: string[];
  failNext: boolean;
  now: number;
  toast: string;
  accountStatus: "normal" | "warning" | "restricted" | "permanent";
  restrictionsEndAt: number | null;
};
export interface AppContextValue extends AppState {
  member: Member | null;
  navigate: (screen: ScreenId, id?: string) => void;
  back: () => void;
  showToast: (message: string) => void;
  login: (id?: string) => void;
  logout: () => Promise<void>;
  updateMember: (patch: Partial<Member>) => void;
  saveDraft: (draft: Draft) => Promise<void>;
  clearDraft: () => Promise<void>;
  publish: (draft: Draft) => OperationResult;
  sendMessage: (
    postId: string,
    text: string,
    conversationId?: string,
  ) => OperationResult;
  requestMatch: (conversationId: string) => OperationResult;
  acceptMatch: (conversationId: string) => OperationResult;
  withdrawMatch: (conversationId: string) => OperationResult;
  rejectApplicant: (conversationId: string) => OperationResult;
  reopenPost: (postId: string) => OperationResult;
  closePost: (postId: string) => OperationResult;
  deletePost: (postId: string) => OperationResult;
  editPost: (postId: string) => void;
  cancel: (postId: string, reason: string) => OperationResult;
  proposeChange: (
    appointmentId: string,
    startsAt: number,
    endsAt: number,
    placeName: string,
  ) => OperationResult;
  acceptChange: (appointmentId: string) => OperationResult;
  rejectChange: (appointmentId: string) => OperationResult;
  confirmCompletion: (appointmentId: string) => OperationResult;
  submitReview: (
    appointmentId: string,
    mood: Review["mood"],
    stars: number,
    comment: string,
    praises: string[],
  ) => OperationResult;
  block: (id: string) => OperationResult;
  unblock: (id: string) => void;
  leaveChat: (conversationId: string) => void;
  markNotificationsRead: (id?: string) => void;
  report: (
    target: string,
    description: string,
    attachment?: string,
  ) => OperationResult;
  addSearch: (text: string) => void;
  clearSearches: () => Promise<void>;
  sendAi: (text: string, modelRequest?: boolean) => Promise<OperationResult>;
  clearAi: () => void;
  hideAiReply: (id: string) => void;
  withdrawAi: (kind: "discovery" | "summary") => void;
  deleteAccount: () => Promise<OperationResult>;
  setPreview: (patch: Partial<AppState>) => void;
  reset: () => Promise<void>;
}
