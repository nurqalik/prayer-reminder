import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundFetch from "expo-background-fetch";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react-native";
import { DateTime } from "luxon";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import "../global.css";
import { Loader } from "./components/loader";

// --------------------- Constants & Types ---------------------
const TASK_NAME = "PRAYER_TIMES_REFRESH";
const NOTIF_CHANNEL_ID = "prayer-reminders";
const PRAYER_KEYS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;

type PrayerName = (typeof PRAYER_KEYS)[number];
type StoredTimings = Record<PrayerName, string>;

interface StoredState {
  dateISO: string; // "YYYY-MM-DD" (device-local)
  lat: number;
  lng: number;
  method: number; // Aladhan method id
  school: 0 | 1; // 0: Shafi, 1: Hanafi
  timings: StoredTimings; // e.g. { Maghrib: "17:32" }
  tz: string; // e.g. "Asia/Jakarta"
}

// --------------------- De-dupe & guard (session) ---------------------
let __isScheduling = false;
const __scheduledKeys = new Set<string>();
const keyFor = (tz: string, name: PrayerName, hhmm: string) =>
  `${tz}|${name}|${hhmm}`;

// Foreground display behavior for local notifications
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
// Device-local calendar date (no UTC shift)
const localDateISO = () => DateTime.now().toFormat("yyyy-LL-dd");

// Aladhan date string, in the current device zone (good enough; API returns TZ)
const dateForApi = () => DateTime.now().toFormat("dd-LL-yyyy");

function cleanHHmm(raw: string): string {
  const m = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) throw new Error(`Invalid time format: ${raw}`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function parseHHmm(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59)
    throw new Error(`Bad HH:mm: ${hhmm}`);
  return { hour: h, minute: m };
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
  const date = dateForApi();
  const url = `https://api.aladhan.com/v1/timings/${date}?latitude=${lat}&longitude=${lng}&method=${method}&school=${school}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json || json.code !== 200)
    throw new Error("Failed to fetch prayer times");

  const all = json.data.timings as Record<string, string>;
  const wanted: StoredTimings = {
    Fajr: cleanHHmm(all.Fajr),
    Dhuhr: cleanHHmm(all.Dhuhr),
    Asr: cleanHHmm(all.Asr),
    Maghrib: cleanHHmm(all.Maghrib),
    Isha: cleanHHmm(all.Isha),
  };
  const tz = json.data.meta.timezone as string;

  console.log(
    `[FETCH] ${date} tz=${tz} readable=${json?.data?.date?.readable}`
  );

  return { timings: wanted, tz };
}

// --------------------- Scheduling helpers (per-prayer) ---------------------
async function scheduleDailyPrayer(name: PrayerName, hhmm: string, tz: string) {
  const { hour, minute } = parseHHmm(hhmm);
  const devTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (devTZ !== tz) {
    console.log(
      `[WARN] Device TZ (${devTZ}) != API TZ (${tz}). Daily triggers use DEVICE TZ.`
    );
  }

  // Avoid duplicate schedules in one app session (we also cancel all before rescheduling)
  const k = keyFor(tz, name, hhmm);
  if (__scheduledKeys.has(k)) {
    console.log(`[SKIP] ${name} already scheduled this session @ ${hhmm}`);
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${name} time`,
      body: `🕌 Waktunya sholat ${name}.\nJadwal: ${hhmm} (${tz})`,
      sound: true,
      categoryIdentifier: CATEGORY_SNOOZE,
    },
    // Calendar DAILY trigger: runs every day at hour:minute (device local time)
    trigger: {
      channelId: NOTIF_CHANNEL_ID,
      hour,
      minute,
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
    },
  });

  console.log(
    `[SCHEDULED] ${name} DAILY @ ${String(hour).padStart(2, "0")}:${String(
      minute
    ).padStart(2, "0")}`
  );
  __scheduledKeys.add(k);

  // If we're exactly at the same minute right now, also fire a one-shot so today isn't missed
  const now = DateTime.now();
  if (now.hour === hour && now.minute === minute) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${name} time (now)`,
        body: `🕌 Waktunya sholat ${name} (sekarang).`,
        sound: true,
      },
      trigger: {
        seconds: 1,
        channelId: NOTIF_CHANNEL_ID,
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      },
    });
    console.log(
      `[FIRED-NOW] ${name} (one-shot) because current time matches ${hhmm}`
    );
  }
}

const CATEGORY_SNOOZE = "SNOOZE_CATEGORY";

async function registerSnoozeCategory() {
  // Register action buttons for iOS & Android
  await Notifications.setNotificationCategoryAsync(CATEGORY_SNOOZE, [
    {
      identifier: "SNOOZE_10",
      buttonTitle: "Remind me later",
      options: { opensAppToForeground: false },
    },
    {
      identifier: "Dismiss",
      buttonTitle: "Dismiss",
    },
  ]);
}

registerSnoozeCategory(); // <= add this

// const aa = async() => {
//   await Notifications.scheduleNotificationAsync({
//     content: {
//       title: `Test`,
//       body: `🕌 Test Notification`,
//       sound: true,
//       categoryIdentifier: CATEGORY_SNOOZE, // <= adds the buttons
//     },
//     // simple 3s timer
//     trigger: { seconds: 3, channelId: NOTIF_CHANNEL_ID, type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL },
//   });

// }

// Five explicit functions you can call independently if needed
async function scheduleFajr(state: StoredState) {
  await scheduleDailyPrayer("Fajr", state.timings.Fajr, state.tz);
}
async function scheduleDhuhr(state: StoredState) {
  await scheduleDailyPrayer("Dhuhr", state.timings.Dhuhr, state.tz);
}
async function scheduleAsr(state: StoredState) {
  await scheduleDailyPrayer("Asr", state.timings.Asr, state.tz);
}
async function scheduleMaghrib(state: StoredState) {
  await scheduleDailyPrayer("Maghrib", state.timings.Maghrib, state.tz);
}
async function scheduleIsha(state: StoredState) {
  await scheduleDailyPrayer("Isha", state.timings.Isha, state.tz);
}

// Master that calls the five
async function scheduleAllPrayers(state: StoredState) {
  if (__isScheduling) {
    console.log("[SCHEDULE] skipped: another run in progress");
    return;
  }
  __isScheduling = true;
  try {
    await ensureNotifChannel();

    // schedule each prayer individually
    await scheduleFajr(state);
    await scheduleDhuhr(state);
    await scheduleAsr(state);
    await scheduleMaghrib(state);
    await scheduleIsha(state);
  } finally {
    __isScheduling = false;
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
async function refreshAndReschedule(method = 20, school: 0 | 1 = 0) {
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

  // Recreate daily schedules fresh (prevents duplicates)
  await Notifications.cancelAllScheduledNotificationsAsync();
  __scheduledKeys.clear();
  await new Promise((r) => setTimeout(r, 50)); // small settle
  await scheduleAllPrayers(state);

  return state;
}

// --------------------- Background Task ---------------------
// Runs periodically; we refresh after midnight or if nothing is scheduled
TaskManager.defineTask(TASK_NAME, async () => {
  try {
    const stored = await loadState();
    const today = localDateISO();

    if (!stored || stored.dateISO !== today) {
      await refreshAndReschedule(stored?.method ?? 20, stored?.school ?? 0);
    } else {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      if (scheduled.length === 0) {
        await scheduleAllPrayers(stored);
      }
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.log("[BG] failed:", String(e));
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

async function ensureBackgroundTaskRegistered() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(TASK_NAME, {
        minimumInterval: 3 * 60 * 60, // OS decides cadence; enough to catch ~after midnight
        stopOnTerminate: false,
        startOnBoot: true,
      });
    }
  } catch (e) {
    // ignore in Expo Go / unsupported envs
    console.log("[BG] register error:", String(e));
  }
}

// --------------------- UI ---------------------
export default function App() {
  const [state, setState] = useState<StoredState | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showcoord, setShowcoord] = useState(false);

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
            await scheduleAllPrayers(stored);
          }
        } else {
          const s = await refreshAndReschedule(
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
      const s = await refreshAndReschedule(
        state?.method ?? 20,
        state?.school ?? 0
      );
      setState(s);
      setLoading(false);
      Alert.alert(
        "Refreshed",
        "Prayer times updated and daily notifications scheduled."
      );
    } catch (e: any) {
      setLoading(false);
      Alert.alert("Error", e?.message ?? "Failed to refresh.");
    }
  };

  const clearSchedules = async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    __scheduledKeys.clear();
    Alert.alert("Cleared", "All scheduled notifications cancelled.");
  };

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const action = response.actionIdentifier;
        if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) return;

        const map: Record<string, number> = {
          SNOOZE_10: 600,
        };
        const seconds = map[action];
        if (!seconds) return;

        // schedule the next notification
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "Sholat Reminder",
            body: `Will remind you again in ${Math.round(
              seconds / 60
            )} minutes.`,
            sound: true,
            categoryIdentifier: CATEGORY_SNOOZE, // keep buttons on the follow-up too
          },
          // time-interval trigger; no need to include "type" if TS complains
          trigger: {
            seconds,
            channelId: NOTIF_CHANNEL_ID,
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          },
        });
      }
    );
    return () => sub.remove();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Prayer Reminder</Text>
      {err ? <Text style={styles.err}>Error: {err}</Text> : null}

      {loading ? (
        <View style={styles.card} className="flex w-full h-96 items-center justify-center ">
          <Loader />
        </View>
      ) : state ? (
        <View style={styles.card}>
          <Text style={styles.row}>Date: {state.dateISO}</Text>
          <Text style={styles.row}>Time Zone: {state.tz}</Text>
          <View className="flex flex-row gap-x-4 items-center justify-start">
          <Text
            style={[styles.row, styles.mtop]}
            onPress={() => setShowcoord(!showcoord)}
          >
            {showcoord
              ? `Coords: ${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}` 
              : `Coords: *.*****, ***.*****`} 
          </Text>
          {showcoord ? <EyeOff  onPress={() => setShowcoord(!showcoord)}/> : <Eye  onPress={() => setShowcoord(!showcoord)}/>}
          </View>
          <View style={styles.times} className="p-8">
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
        <Text style={styles.row}>Initializing...</Text>
      )}

        {loading ? (
          <Loader label='Loading...' />
        ) : (
          <View className="flex flex-row gap-x-8 items-center justify-end px-8">
          <RefreshCw disabled={loading} onPress={manualRefresh} />
        <Trash2 onPress={clearSchedules} />
      </View>
        )}
      {/* <View style={styles.buttons}>
        <Button
          title="Test Notif"
          onPress={aa}
        />
      </View> */}

      <Text style={styles.note}>
        Note: the daily trigger uses the device's time zone. Make sure it
        matches {`"${state?.tz ?? "API TZ"}"`}. The app will refresh
        automatically after midnight (via background task), or whenever you tap
        “Refresh now”.
      </Text>
      <View style={styles.footer}>
        <Text style={styles.footerText}>© Roe 2025 • All right reserved</Text>
      </View>
      {/* <LoaderOverlay visible={loading} label="Refreshing prayer times…" /> */}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 60, flexGrow: 1 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 10 },
  row: { fontSize: 16, marginTop: 6 },
  rowSmall: { fontSize: 14, marginTop: 6, color: "#374151", textAlign: "center" },
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
  footer: {
    marginTop: "auto", // key: pushes footer to bottom of content
    alignItems: "center",
    paddingVertical: 12,
  },
  footerText: {
    color: "#64748b",
    fontSize: 12,
  },
});
