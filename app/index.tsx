import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundFetch from "expo-background-fetch";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { DateTime } from "luxon";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

// --------------------- Constants & Types ---------------------
const TASK_NAME = "PRAYER_TIMES_REFRESH";
const NOTIF_CHANNEL_ID = "prayer-reminders";
const PRAYER_KEYS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;

type PrayerName = (typeof PRAYER_KEYS)[number];
type StoredTimings = Record<PrayerName, string>; // e.g. "05:10"

interface StoredState {
  dateISO: string; // "YYYY-MM-DD" (device-local date)
  lat: number;
  lng: number;
  method: number; // Aladhan calc method id
  school: 0 | 1; // 0: Shafi, 1: Hanafi
  timings: StoredTimings;
  tz: string; // API-reported timezone
}

// Ensure foreground display for local notifications
Notifications.setNotificationHandler({
  handleNotification:
    async (): Promise<Notifications.NotificationBehavior> => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
});

// --------------------- Utilities ---------------------
const localDateISO = (d = new Date()) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate())
    .toISOString()
    .slice(0, 10);

function cleanHHmm(raw: string): string {
  // Accept "5:03", "05:03", "05:03 (UTC+7)" etc.
  const m = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) throw new Error(`Invalid time format: ${raw}`);
  const h = m[1].padStart(2, "0");
  const minutes = m[2];
  return `${h}:${minutes}`;
}

// Build a trigger Date for *today* in the API timezone; return null if not safely in the future.
function nextTriggerToday(hhmm: string, apiZone: string): Date | null {
  const [h, m] = hhmm.split(":").map(Number);
  const nowZ = DateTime.now().setZone(apiZone);
  const dtZ = nowZ.set({ hour: h, minute: m, second: 0, millisecond: 0 });

  // 30s safety guard: if time is past or basically "now", skip to prevent instant pop
  if (dtZ <= nowZ.plus({ seconds: 30 })) return null;

  // Notifications API wants a JS Date in device-local time:
  return dtZ.toLocal().toJSDate();
}

async function ensureNotifChannel() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(NOTIF_CHANNEL_ID, {
      name: "Prayer Reminders",
      importance: Notifications.AndroidImportance.HIGH,
      bypassDnd: true,
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

async function requestPermissions() {
  const { status: locStatus } =
    await Location.requestForegroundPermissionsAsync();
  if (locStatus !== "granted") throw new Error("Location permission denied");

  const { status: notifStatus } = await Notifications.requestPermissionsAsync();
  if (notifStatus !== "granted")
    throw new Error("Notification permission denied");
}

// --------------------- API ---------------------
async function fetchPrayerTimes(
  lat: number,
  lng: number,
  method = 20,
  school: 0 | 1 = 0
) {
  const date = localDateISO(); // e.g. "2025-08-21"
  const url = `https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=${method}&school=${school}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json || json.code !== 200)
    throw new Error("Failed to fetch prayer times");

  const all = json.data.timings as Record<string, string>;
  const wanted = {
    Fajr: cleanHHmm(all.Fajr),
    Dhuhr: cleanHHmm(all.Dhuhr),
    Asr: cleanHHmm(all.Asr),
    Maghrib: cleanHHmm(all.Maghrib),
    Isha: cleanHHmm(all.Isha),
  };
  const tz = json.data.meta.timezone as string; // <-- critical
  return { timings: wanted, tz };
}

// --------------------- Scheduling ---------------------
async function cancelExistingSchedules() {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    all.map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
  );
}

function debugLog(name: string, hhmm: string, zone: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const nowZ = DateTime.now().setZone(zone);
  const dtZ = nowZ.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  console.log(
    `[${name}] zone=${zone} nowZ=${nowZ.toISO()} hhmm=${hhmm} dtZ=${dtZ.toISO()} local=${dtZ
      .toLocal()
      .toISO()} Δmin=${dtZ
      .diff(nowZ, "minutes")
      .toObject()
      .minutes?.toFixed(1)}`
  );
}

async function scheduleNotificationsForToday(state: StoredState) {
  await ensureNotifChannel();

  for (const name of PRAYER_KEYS) {
    const trigger = nextTriggerToday(state.timings[name], state.tz);
    if (!trigger) continue; // skip past or too-close times

    // Final local lead-time guard to avoid any "instant" pops
    const msLead = trigger.getTime() - Date.now();
    if (msLead < 35_000) {
      console.log(`[SKIP] ${name} too close: ${Math.round(msLead / 1000)}s`);
      continue;
    }

    debugLog(name, state.timings[name], state.tz);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${name} time`,
        body: "Waktunya sholat.",
        sound: true,
      },
      trigger: { date: trigger, channelId: NOTIF_CHANNEL_ID },
    });
  }
}

// --------------------- Persistence ---------------------
async function saveState(s: StoredState) {
  await AsyncStorage.setItem("@prayer_state", JSON.stringify(s));
}
async function loadState(): Promise<StoredState | null> {
  const raw = await AsyncStorage.getItem("@prayer_state");
  return raw ? (JSON.parse(raw) as StoredState) : null;
}

// --------------------- Refresh pipeline ---------------------
async function refreshAndSchedule(method = 20, school: 0 | 1 = 0) {
  const loc = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  const { latitude: lat, longitude: lng } = loc.coords;

  const { timings, tz } = await fetchPrayerTimes(lat, lng, method, school);

  const state: StoredState = {
    dateISO: localDateISO(),
    lat,
    lng,
    method,
    school,
    timings,
    tz,
  };

  await saveState(state);
  await cancelExistingSchedules();
  await scheduleNotificationsForToday(state);
  return state;
}

// --------------------- Background Task ---------------------
TaskManager.defineTask(TASK_NAME, async () => {
  try {
    const stored = await loadState();
    const today = localDateISO();

    if (!stored || stored.dateISO !== today) {
      await refreshAndSchedule(stored?.method ?? 20, stored?.school ?? 0);
    } else {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      if (scheduled.length === 0) {
        await scheduleNotificationsForToday(stored);
      }
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

async function ensureBackgroundTaskRegistered() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(TASK_NAME, {
        minimumInterval: 3 * 60 * 60, // ~3 hours; OS decides actual cadence
        stopOnTerminate: false,
        startOnBoot: true,
      });
    }
  } catch {
    // In Expo Go or unsupported environments, registration may not be available.
    // We silently ignore so the app still runs perfectly in the foreground.
  }
}

// --------------------- UI ---------------------
export default function App() {
  const [state, setState] = useState<StoredState | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await requestPermissions();
        await ensureBackgroundTaskRegistered();

        const stored = await loadState();
        const today = localDateISO();

        if (stored && stored.dateISO === today) {
          setState(stored);
          const scheduled =
            await Notifications.getAllScheduledNotificationsAsync();
          if (scheduled.length === 0) {
            await scheduleNotificationsForToday(stored);
          }
        } else {
          const s = await refreshAndSchedule(
            stored?.method ?? 20,
            stored?.school ?? 0
          );
          setState(s);
        }
      } catch (e: any) {
        setErr(e?.message ?? "Initialization failed");
      }
    })();
  }, []);

  const manualRefresh = async () => {
    try {
      setLoading(true);
      const s = await refreshAndSchedule(
        state?.method ?? 20,
        state?.school ?? 0
      );
      setState(s);
      setLoading(false);
      Alert.alert(
        "Refreshed",
        "Prayer times updated and notifications scheduled."
      );
    } catch (e: any) {
      setLoading(false);
      Alert.alert("Error", e?.message ?? "Failed to refresh.");
    }
  };

  const testInSeconds = async (sec: number) => {
    if (!state) return Alert.alert("Test", "State not ready yet.");

    const nowZ = DateTime.now().setZone(state.tz);
    const targetZ = nowZ.plus({ seconds: sec });
    const triggerDate = targetZ.toLocal().toJSDate();

    await cancelExistingSchedules();
    await ensureNotifChannel();

    console.log(
      `[TEST-SEC] in ${sec}s | tz=${
        state.tz
      } | local=${triggerDate.toISOString()} | deviceTZ=${
        Intl.DateTimeFormat().resolvedOptions().timeZone
      }`
    );

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Test in ${sec}s`,
        body: "Seconds-based test.",
        sound: true,
      },
      trigger: { date: triggerDate, channelId: NOTIF_CHANNEL_ID },
    });

    Alert.alert("Test scheduled", `Will fire in ~${sec} seconds.`);
  };

  const clearSchedules = async () => {
    await cancelExistingSchedules();
    Alert.alert("Cleared", "All scheduled notifications cancelled.");
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Prayer Reminder</Text>
      {err ? <Text style={styles.err}>Error: {err}</Text> : null}

      {state ? (
        <View style={styles.card}>
          <Text style={styles.row}>Date: {state.dateISO}</Text>
          <Text style={styles.row}>TZ: {state.tz}</Text>
          <Text style={[styles.row, styles.mtop]}>
            Coords: {state.lat.toFixed(5)}, {state.lng.toFixed(5)}
          </Text>
          <View style={styles.times}>
            {PRAYER_KEYS.map((k) => (
              <Text key={k} style={styles.timeRow}>
                {k}: {state.timings[k]}
              </Text>
            ))}
          </View>
          <Text style={styles.rowSmall}>
            Method: {state.method} · School:{" "}
            {state.school === 0 ? "Shafi" : "Hanafi"}
          </Text>
        </View>
      ) : (
        <Text style={styles.row}>Initializing…</Text>
      )}

      <View style={styles.buttons}>
        <Button
          title={loading ? "Refreshing…" : "Refresh now"}
          onPress={manualRefresh}
          disabled={loading}
        />
      </View>
      <View style={styles.buttons}>
        <Button
          title="Cancel all notifications"
          color={Platform.OS === "ios" ? undefined : "#ef4444"}
          onPress={clearSchedules}
        />
      </View>
      <View style={styles.buttons}>
        <Button title="Test next minute" onPress={() => testInSeconds(100)} />
      </View>

      <Text style={styles.note}>
        Notes: On Android 12+, enable “Alarms & reminders” in system settings
        for exact delivery. The app still works without it.
      </Text>
      <Text style={styles.note}>&copy; Roe 2025</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 60 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 10 },
  row: { fontSize: 16, marginTop: 6 },
  rowSmall: { fontSize: 14, marginTop: 6, color: "#374151" },
  err: { color: "#ef4444", marginBottom: 10 },
  card: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#f1f5f9",
    marginVertical: 12,
  },
  times: { marginTop: 10 },
  timeRow: { fontSize: 18, fontWeight: "600", marginVertical: 2 },
  mtop: { marginTop: 10 },
  buttons: { marginTop: 10 },
  note: { fontSize: 12, color: "#475569", marginTop: 14 },
});
