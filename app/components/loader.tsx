import React, { useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  StyleProp,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  ViewStyle,
} from "react-native";

type LoaderProps = {
  /** Inline usage (inside layouts, not full-screen) */
  label?: string;
  size?: "small" | "large";
  style?: StyleProp<ViewStyle>;
  color?: string;
};

export const Loader: React.FC<LoaderProps> = ({
  label,
  size = "small",
  style,
  color,
}) => {
  const scheme = useColorScheme();
  const textColor = useMemo(
    () => color ?? (scheme === "dark" ? "#e5e7eb" : "#111827"),
    [scheme, color]
  );

  return (
    <View style={[styles.inlineWrap, style]}>
      <ActivityIndicator size={size} />
      {label ? <Text className="text-black">{label}</Text> : null}
    </View>
  );
};

type LoaderOverlayProps = {
  /** When true, shows a full-screen blocking overlay */
  visible: boolean;
  /** Optional label under the spinner */
  label?: string;
  /** Dim amount (0..1), default 0.25 */
  dimOpacity?: number;
  /** Spinner color (auto by theme if not given) */
  spinnerColor?: string;
};

export const LoaderOverlay: React.FC<LoaderOverlayProps> = ({
  visible,
  label,
  dimOpacity = 0.25,
  spinnerColor,
}) => {
  const fade = useRef(new Animated.Value(0)).current;
  const scheme = useColorScheme();

  useEffect(() => {
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [visible, fade]);

  const textColor = spinnerColor ?? (scheme === "dark" ? "#f8fafc" : "#0f172a");

  return (
    <Modal
      transparent
      visible={visible}
      statusBarTranslucent
      onRequestClose={() => {}}
    >
      <Animated.View
        style={[
          styles.overlay,
          { backgroundColor: `rgba(0,0,0,${dimOpacity})`, opacity: fade },
        ]}
        pointerEvents={visible ? "auto" : "none"}
      >
        <View style={styles.overlayCard}>
          <ActivityIndicator
            size={Platform.OS === "ios" ? "large" : 50}
            color={scheme === "dark" ? "#ffffff" : undefined}
          />
          {label ? (
            <Text style={[styles.overlayText, { color: textColor }]}>{label}</Text>
          ) : null}
        </View>
      </Animated.View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  inlineWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inlineText: {
    fontSize: 14,
    fontWeight: "600",
  },
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  overlayCard: {
    minWidth: 160,
    maxWidth: "80%",
    alignItems: "center",
    gap: 12,
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.92)",
    ...Platform.select({
      android: { elevation: 6 },
      ios: { shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
    }),
  },
  overlayText: {
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
});
