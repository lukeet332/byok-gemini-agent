// Animated splash: the Fraude mark spins/scales in, the title fades up, then the
// whole overlay fades out and calls onFinish. Uses RN Animated (no extra deps).

import React, { useEffect, useRef } from "react";
import { Animated, Easing, Image, StyleSheet, Text } from "react-native";

import { theme } from "../theme";

export default function AnimatedSplash({ onFinish }: { onFinish: () => void }) {
  const scale = useRef(new Animated.Value(0.5)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const markOpacity = useRef(new Animated.Value(0)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const overlayOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(markOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 5, tension: 70, useNativeDriver: true }),
        Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.timing(titleOpacity, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.delay(550),
      Animated.timing(overlayOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(() => onFinish());
  }, []);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] });

  return (
    <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
      <Animated.Image
        source={require("../../assets/logo-mark.png")}
        style={[styles.mark, { opacity: markOpacity, transform: [{ scale }, { rotate }] }]}
        resizeMode="contain"
      />
      <Animated.Text style={[styles.title, { opacity: titleOpacity }]}>Fraude</Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  mark: { width: 180, height: 180 },
  title: { color: theme.accent, fontSize: 34, fontWeight: "800", marginTop: 12, letterSpacing: 1 },
});
