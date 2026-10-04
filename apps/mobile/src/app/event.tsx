import React from "react";
import { EventDetailScreen } from "../screens/BrowseScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <EventDetailScreen id={id || "gallery"} />;
}
