import React from "react";
import { PostDetailScreen } from "../screens/BrowseScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <PostDetailScreen id={id || "post-2"} />;
}
