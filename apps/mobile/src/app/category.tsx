import React from "react";
import { CategoryScreen } from "../screens/BrowseScreens";
import { useLocalSearchParams } from "expo-router";
export default function Route() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <CategoryScreen id={id || "전시"} />;
}
