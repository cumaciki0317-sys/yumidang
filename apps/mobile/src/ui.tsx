import React, { useCallback } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
  type ColorValue,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "./state";
import { useFocusEffect } from "expo-router";
import { maskName } from "./domain";
import type { Member, Post, EventItem } from "./types";

export const colors = {
  primary: "#6C2CF5",
  deep: "#5300D1",
  ink: "#202034",
  muted: "#767486",
  faint: "#A19DAC",
  line: "#EAE6F2",
  background: "#FAF9FE",
  surface: "#FFFFFF",
  lavender: "#F1ECFF",
  green: "#16866E",
  pink: "#FFF0F4",
  red: "#CC425C",
};
export const art: Record<string, any> = {
  logo: require("../assets/stitch/logo.png"),
  festival: require("../assets/stitch/festival.jpg"),
  gallery: require("../assets/stitch/gallery.jpg"),
  avatar: require("../assets/stitch/avatar.jpg"),
  peer: require("../assets/stitch/peer.jpg"),
};
export function Icon({
  name,
  size = 21,
  color = colors.ink,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  size?: number;
  color?: ColorValue;
}) {
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
export function Body({
  children,
  muted = false,
  small = false,
  style,
}: {
  children: React.ReactNode;
  muted?: boolean;
  small?: boolean;
  style?: any;
}) {
  return (
    <Text style={[s.body, muted && s.muted, small && s.small, style]}>
      {children}
    </Text>
  );
}
export function Title({
  children,
  large = false,
  style,
}: {
  children: React.ReactNode;
  large?: boolean;
  style?: any;
}) {
  return <Text style={[s.title, large && s.large, style]}>{children}</Text>;
}
export function Row({
  children,
  between = false,
  style,
}: {
  children: React.ReactNode;
  between?: boolean;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[s.row, between && { justifyContent: "space-between" }, style]}
    >
      {children}
    </View>
  );
}
export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.card, style, pressed && { opacity: 0.8 }]}
    >
      {children}
    </Pressable>
  ) : (
    <View style={[s.card, style]}>{children}</View>
  );
}
export function Divider() {
  return <View style={s.divider} />;
}
export function Badge({
  children,
  tone = "purple",
}: {
  children: React.ReactNode;
  tone?: "purple" | "green" | "gray" | "pink";
}) {
  return (
    <View
      style={[
        s.badge,
        tone === "green" && { backgroundColor: "#E8F6EF" },
        tone === "gray" && { backgroundColor: "#F1F0F5" },
        tone === "pink" && { backgroundColor: colors.pink },
      ]}
    >
      <Text
        style={[
          s.badgeText,
          tone === "green" && { color: colors.green },
          tone === "gray" && { color: colors.muted },
          tone === "pink" && { color: colors.red },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}
export function Button({
  children,
  onPress,
  secondary = false,
  disabled = false,
  loading = false,
  icon,
  testID,
  style,
}: {
  children: React.ReactNode;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  testID?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={typeof children === "string" ? children : undefined}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        (disabled || loading) && { opacity: 0.42 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? colors.primary : "#fff"} />
      ) : (
        <>
          {icon && (
            <Icon
              name={icon}
              color={secondary ? colors.primary : "#fff"}
              size={18}
            />
          )}
          <Text style={[s.buttonText, secondary && { color: colors.primary }]}>
            {children}
          </Text>
        </>
      )}
    </Pressable>
  );
}
export function TextButton({
  children,
  onPress,
  color = colors.primary,
}: {
  children: React.ReactNode;
  onPress: () => void;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ paddingVertical: 8 }}
    >
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{children}</Text>
    </Pressable>
  );
}
export function Chip({
  children,
  selected = false,
  onPress,
  disabled = false,
}: {
  children: React.ReactNode;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        s.chip,
        selected && {
          backgroundColor: colors.lavender,
          borderColor: "#D6C5FF",
        },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Text
        style={{
          fontSize: 13,
          color: selected ? colors.primary : colors.muted,
          fontWeight: selected ? "700" : "500",
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Field({
  label,
  error,
  hint,
  ...props
}: TextInputProps & { label?: string; error?: string; hint?: string }) {
  return (
    <View style={{ gap: 8 }}>
      {label && <Text style={s.label}>{label}</Text>}
      <TextInput
        placeholderTextColor={colors.faint}
        accessibilityLabel={label || props.placeholder}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 100, textAlignVertical: "top" },
          error && { borderColor: colors.red },
          props.style,
        ]}
      />
      {error ? (
        <Body small style={{ color: colors.red }}>
          {error}
        </Body>
      ) : hint ? (
        <Body small muted>
          {hint}
        </Body>
      ) : null}
    </View>
  );
}
export function Section({
  title,
  action,
  onPress,
  children,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 14 }}>
      <Row between>
        <Title>{title}</Title>
        {action && onPress && (
          <TextButton onPress={onPress}>{action} ›</TextButton>
        )}
      </Row>
      {children}
    </View>
  );
}
export function Empty({
  title,
  description,
  action,
  onPress,
  icon = "leaf-outline",
}: {
  title: string;
  description?: string;
  action?: string;
  onPress?: () => void;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={30} color={colors.primary} />
      </View>
      <Title>{title}</Title>
      {description && (
        <Body muted style={{ textAlign: "center" }}>
          {description}
        </Body>
      )}
      {action && onPress && (
        <Button secondary onPress={onPress}>
          {action}
        </Button>
      )}
    </View>
  );
}
export function Avatar({
  member,
  size = 40,
}: {
  member?: Member | null;
  size?: number;
}) {
  return member?.photo ? (
    <Image
      source={art[member.photo] || { uri: member.photo }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.lavender,
      }}
    />
  ) : (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.lavender,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="person-outline" size={size * 0.42} color={colors.primary} />
    </View>
  );
}
export function Artwork({
  name,
  height = 180,
  style,
}: {
  name?: string;
  height?: number;
  style?: any;
}) {
  return name ? (
    <Image
      source={art[name] || { uri: name }}
      style={[
        { width: "100%", height, backgroundColor: colors.lavender },
        style,
      ]}
      resizeMode="cover"
    />
  ) : (
    <LinearGradient
      colors={["#CBB7FC", "#EFDEFE"]}
      style={[
        { height, alignItems: "center", justifyContent: "center" },
        style,
      ]}
    >
      <Icon name="flower-outline" size={48} color={colors.primary} />
    </LinearGradient>
  );
}
export function dateLabel(value: number, short = false) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    ...(short ? {} : { weekday: "short" }),
  }).format(value);
}
export function timeLabel(value: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}
export function rangeLabel(start: number, end: number) {
  return `${dateLabel(start)} ${timeLabel(start)}–${timeLabel(end)}`;
}
export function masked(name: string) {
  return maskName(name);
}
export function statusLabel(status: Post["status"]) {
  return {
    recruiting: "모집 중",
    closed: "모집 마감",
    awaiting_consent: "최종 동의 대기",
    confirmed: "동행 확정",
    completed: "동행 완료",
    deleted: "삭제된 공고",
  }[status];
}
export function MemberBox({
  memberId,
  confirmed = false,
  onPress,
  compact = false,
}: {
  memberId: string;
  confirmed?: boolean;
  onPress?: () => void;
  compact?: boolean;
}) {
  const app = useApp();
  if (!app.member)
    return (
      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          app.navigate("S05");
        }}
        accessibilityRole="button"
        style={s.guard}
        testID="author-login-guard"
      >
        <Row>
          <View style={s.mosaicAvatar} />
          <View style={{ gap: 6 }}>
            <View style={s.mosaicLine} />
            <View style={[s.mosaicLine, { width: 72 }]} />
          </View>
        </Row>
        <Text style={s.guardText}>동행인은 로그인 후 확인할 수 있어요</Text>
      </Pressable>
    );
  const m = app.members[memberId];
  if (!m) return <Body muted>탈퇴한 사용자입니다.</Body>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={(e) => {
        e.stopPropagation();
        (onPress || (() => app.navigate("S14", memberId)))();
      }}
      style={[
        s.memberBox,
        compact && { padding: 0, backgroundColor: "transparent" },
      ]}
    >
      <Row>
        <Avatar member={m} />
        <View style={{ flex: 1, gap: 4 }}>
          <Body style={{ fontWeight: "700" }}>
            {confirmed || app.viewerId === memberId ? m.name : masked(m.name)}{" "}
            <Text style={s.muted}>만 {m.age}세</Text>
          </Body>
          <Row>
            <Text
              style={{ color: colors.primary, fontSize: 11, fontWeight: "700" }}
            >
              당도 {m.sweetness}
            </Text>
            <View style={s.meter}>
              <View
                style={{
                  width: `${m.sweetness}%`,
                  height: 3,
                  backgroundColor: colors.primary,
                }}
              />
            </View>
          </Row>
        </View>
        <Icon name="chevron-forward" size={16} color={colors.faint} />
      </Row>
    </Pressable>
  );
}
export function PostCard({ post }: { post: Post }) {
  const app = useApp();
  return (
    <Card
      onPress={() => app.navigate("S02", post.id)}
      style={{ padding: 0, overflow: "hidden" }}
    >
      <View style={{ padding: 18, gap: 12 }}>
        <Row between>
          <Row>
            <Badge>{post.category}</Badge>
            <Badge tone={post.status === "recruiting" ? "green" : "gray"}>
              {statusLabel(
                post.status === "recruiting" && app.now >= post.deadlineAt
                  ? "closed"
                  : post.status,
              )}
            </Badge>
          </Row>
          <Text style={{ fontSize: 11, color: colors.faint }}>무료 1:1</Text>
        </Row>
        <Title style={{ fontSize: 17, lineHeight: 25 }}>{post.title}</Title>
        <View style={{ gap: 5 }}>
          <Row>
            <Icon name="calendar-outline" size={14} color={colors.muted} />
            <Body small muted>
              {rangeLabel(post.startsAt, post.endsAt)}
            </Body>
          </Row>
          <Row>
            <Icon name="location-outline" size={14} color={colors.muted} />
            <Body small muted>
              {post.publicArea}
            </Body>
          </Row>
        </View>
        {post.eventId && (
          <View
            style={{
              backgroundColor: colors.lavender,
              padding: 9,
              borderRadius: 8,
            }}
          >
            <Body small style={{ color: colors.primary }}>
              ♧ 연결 행사와 함께하는 동행
            </Body>
          </View>
        )}
      </View>
      <Divider />
      <View style={{ padding: 14 }}>
        <MemberBox
          memberId={post.authorId}
          compact
          confirmed={app.appointments.some(
            (a) =>
              a.postId === post.id &&
              a.status !== "cancelled" &&
              [a.hostId, a.applicantId].includes(app.viewerId || ""),
          )}
        />
      </View>
    </Card>
  );
}
export function EventCard({
  event,
  onPress,
}: {
  event: EventItem;
  onPress?: () => void;
}) {
  const app = useApp();
  return (
    <Card
      onPress={onPress || (() => app.navigate("S09-3", event.id))}
      style={{ padding: 0, overflow: "hidden" }}
    >
      <Artwork name={event.image} height={155} />
      <View style={{ padding: 16, gap: 8 }}>
        <Row>
          <Badge>{event.category}</Badge>
          <Body small muted>
            {event.price}
          </Body>
        </Row>
        <Title style={{ fontSize: 17 }}>{event.title}</Title>
        <Body small muted>
          {dateLabel(event.startsAt)}–{dateLabel(event.endsAt)} ·{" "}
          {event.publicArea}
        </Body>
        <Body small muted>
          출처 {event.sourceName}
        </Body>
      </View>
    </Card>
  );
}
export function Screen({
  children,
  title,
  tab = false,
  right,
  footer,
  scroll = true,
  back = true,
  onBack,
}: {
  children: React.ReactNode;
  title?: string;
  tab?: boolean;
  right?: React.ReactNode;
  footer?: React.ReactNode;
  scroll?: boolean;
  back?: boolean;
  onBack?: () => void;
}) {
  useFocusEffect(
    useCallback(() => {
      if (!onBack) return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          onBack();
          return true;
        },
      );
      const escape = (event: any) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onBack();
        }
      };
      if (Platform.OS === "web")
        globalThis.addEventListener?.("keydown", escape);
      return () => {
        subscription.remove();
        if (Platform.OS === "web")
          globalThis.removeEventListener?.("keydown", escape);
      };
    }, [onBack]),
  );
  const app = useApp();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{
        flex: 1,
        backgroundColor: colors.background,
        paddingTop: insets.top,
      }}
    >
      {title && (
        <View style={s.header}>
          {!tab && back ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="뒤로 가기"
              onPress={onBack || app.back}
              style={s.iconButton}
            >
              <Icon name="chevron-back" />
            </Pressable>
          ) : null}
          <Title style={{ flex: 1, fontSize: tab ? 22 : 17 }}>{title}</Title>
          {right}
        </View>
      )}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[s.content, { paddingBottom: tab ? 100 : 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 20 }}>{children}</View>
      )}
      {footer && (
        <View
          style={[s.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}
        >
          {footer}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
export const s = StyleSheet.create({
  body: { fontSize: 14, lineHeight: 22, color: colors.ink },
  small: { fontSize: 12, lineHeight: 19 },
  muted: { color: colors.muted },
  title: {
    fontSize: 19,
    lineHeight: 27,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: colors.ink,
  },
  large: { fontSize: 28, lineHeight: 37, letterSpacing: -1 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    gap: 14,
  },
  divider: { height: 1, backgroundColor: colors.line },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.lavender,
  },
  badgeText: { fontSize: 10, fontWeight: "700", color: colors.primary },
  button: {
    minHeight: 50,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 13,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonText: { fontSize: 15, fontWeight: "700", color: "#fff" },
  secondary: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#D8C9FF",
  },
  chip: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  label: { fontSize: 13, fontWeight: "600", color: colors.ink },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#fff",
    fontSize: 14,
    color: colors.ink,
  },
  empty: {
    padding: 30,
    gap: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyIcon: {
    height: 65,
    width: 65,
    borderRadius: 24,
    backgroundColor: colors.lavender,
    alignItems: "center",
    justifyContent: "center",
  },
  guard: {
    minHeight: 62,
    borderRadius: 12,
    backgroundColor: "#F3F1F8",
    padding: 12,
    gap: 8,
  },
  guardText: { fontSize: 12, color: colors.muted, textAlign: "center" },
  mosaicAvatar: {
    height: 32,
    width: 32,
    borderRadius: 12,
    backgroundColor: "#DAD5E6",
  },
  mosaicLine: {
    height: 7,
    width: 104,
    borderRadius: 4,
    backgroundColor: "#DDD7E8",
  },
  memberBox: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.lavender,
  },
  meter: {
    height: 3,
    width: 65,
    backgroundColor: "#E6DCF8",
    borderRadius: 2,
    overflow: "hidden",
  },
  header: {
    height: 64,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.background,
  },
  iconButton: { height: 36, width: 30, justifyContent: "center" },
  content: { paddingHorizontal: 20, paddingTop: 12, gap: 22 },
  footer: {
    padding: 18,
    gap: 12,
    borderTopWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#fff",
  },
});

export const styles = s;
