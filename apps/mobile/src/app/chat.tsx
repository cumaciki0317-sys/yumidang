import React from "react";
import { useLocalSearchParams } from "expo-router";
import { ChatScreen } from "../screens/CommunityScreens";
import { useApp } from "../state";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const app = useApp();
  const c = app.conversations.find((c) => c.id === id);
  return (
    <ChatScreen
      key={id || "post-2"}
      id={c?.postId || id || "post-2"}
      conversationId={c?.id}
    />
  );
}
